defmodule TracerBackend.SystemTracer do
  @moduledoc """
  アクターモデルシステム向けの透過的なトレーシング機構．
  Erlang VMの組み込みトレーシング機能を利用して，
  ライフサイクルイベントやプロセス間通信（IPC）をキャプチャし，
  トレースイベントにリアルタイムでHybrid Logical Clocks (HLC) を割り当てる．
  """
  use GenServer

  def start_link(_) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def trace_tree(supervisor_pid) do
    GenServer.call(__MODULE__, {:trace_tree, supervisor_pid})
  end

  # --- Callbacks ---

  @impl GenServer
  def init(_) do
    :ets.new(:clock_storage, [:named_table, :public, :set])
    :ets.new(:inflight_messages, [:named_table, :public, :bag])
    IO.puts("[SystemTracer] Initialized in-memory clock storages.")
    {:ok, %{traced_modules: MapSet.new()}}
  end

  @impl GenServer
  def handle_call({:trace_tree, target_pid}, _from, state) do
    initial_clock = TracerBackend.HLC.new() |> TracerBackend.HLC.send()
    :ets.insert(:clock_storage, {target_pid, initial_clock})
    :erlang.trace(target_pid, true, [:send, :receive, :procs, :set_on_spawn, :call])
    new_state = ensure_module_traced(target_pid, state)
    IO.puts("[SystemTracer] Trace attached to node: #{inspect(target_pid)} and its descendants.")
    {:reply, :ok, new_state}
  end

  # --- Trace Event Handlers ---

  @impl GenServer
  def handle_info({:trace, parent_pid, :spawn, child_pid, mfa}, state) do
    parent_clock = get_clock(parent_pid)
    new_parent_clock = TracerBackend.HLC.send(parent_clock)
    :ets.insert(:clock_storage, {parent_pid, new_parent_clock})

    child_clock = TracerBackend.HLC.send(new_parent_clock)
    :ets.insert(:clock_storage, {child_pid, child_clock})

    resolved_child_name = get_process_name(child_pid)
    spawn_payload = resolve_spawn_payload(child_pid, mfa, resolved_child_name)

    broadcast_event("SPAWN", parent_pid, child_pid, spawn_payload, child_clock, resolved_child_name)
    {:noreply, state}
  end

  @impl GenServer
  def handle_info({:trace, sender, :send, payload, receiver}, state) do
    sender_clock = get_clock(sender)
    new_clock = TracerBackend.HLC.send(sender_clock, physical_clock_for(sender))
    :ets.insert(:clock_storage, {sender, new_clock})
    :ets.insert(:inflight_messages, {{receiver, payload}, sender, new_clock})

    broadcast_event("SEND", sender, receiver, payload, new_clock)

    new_state = ensure_module_traced(sender, state)
    {:noreply, new_state}
  end

  @impl GenServer
  def handle_info({:trace, receiver, :receive, payload}, state) do
    receiver_clock = get_clock(receiver)
    clock_fun = physical_clock_for(receiver)

    {new_clock, sender_pid} =
      case :ets.lookup(:inflight_messages, {receiver, payload}) do
        [record | _] ->
          {_, sender, msg_clock} = record
          :ets.delete_object(:inflight_messages, record)
          {TracerBackend.HLC.receive(receiver_clock, msg_clock, clock_fun), sender}
        [] ->
          {TracerBackend.HLC.send(receiver_clock, clock_fun), nil}
      end

    :ets.insert(:clock_storage, {receiver, new_clock})
    broadcast_event("RECEIVE", receiver, sender_pid, payload, new_clock)

    new_state = ensure_module_traced(receiver, state)
    {:noreply, new_state}
  end

  @impl GenServer
  def handle_info({:trace, pid, :exit, reason}, state) do
    clock = get_clock(pid)
    broadcast_event("EXIT", pid, nil, reason, clock)
    {:noreply, state}
  end

  @impl GenServer
  def handle_info({:trace, pid, :return_from, {_mod, fun, _arity}, return_val}, state)
      when fun in [:init, :handle_cast, :handle_call, :handle_info, :handle_continue] do

    case extract_genserver_state(return_val) do
      :unknown -> :ok
      new_state_val ->
        current_clock = get_clock(pid)
        new_clock = TracerBackend.HLC.send(current_clock)
        :ets.insert(:clock_storage, {pid, new_clock})
        broadcast_event("LOCAL EVENT", pid, nil, new_state_val, new_clock)
    end
    {:noreply, state}
  end

  @impl GenServer
  def handle_info({:trace, _pid, :call, _mfa}, state) do
    {:noreply, state}
  end

  @impl GenServer
  def handle_info({:trace, _, _, _}, state), do: {:noreply, state}
  def handle_info({:trace, _, _, _, _}, state), do: {:noreply, state}

  # --- Helper Functions ---

  defp get_clock(pid) do
    case :ets.lookup(:clock_storage, pid) do
      [{^pid, clock}] -> clock
      [] -> TracerBackend.HLC.new()
    end
  end

  defp broadcast_event(type, source, target, payload, clock, target_name_override \\ nil) do
    target_name = target_name_override || get_process_name(target)
    src_name = get_process_name(source)

    {pt, c} =
      case clock do
        %TracerBackend.HLC{pt: pt_val, c: c_val} -> {pt_val, c_val}
        _ -> {System.os_time(:millisecond), 0}
      end

    category = safe_classify(type, src_name, target_name, payload)

    event_data = %{
      type: type,
      category: category, # :app | :otp | :system | :timer
      source: format_term(source),
      source_name: src_name,
      target: format_term(target),
      target_name: target_name,
      payload: if(is_binary(payload), do: payload, else: format_term(payload)),
      clock: "#{pt}-#{c}",
      hlc_pt: pt,
      hlc_c: c
    }

    Phoenix.PubSub.broadcast(
      TracerBackend.PubSub,
      "trace_events:lobby",
      {:new_trace_event, event_data}
    )
  end

  defp safe_classify(type, src_name, tgt_name, payload) do
    classify_logic(type, to_string(src_name || ""), to_string(tgt_name || ""), inspect(payload))
  rescue
    _ -> :app
  end

  defp classify_logic(type, src_str, tgt_str, payload_str) do
    cond do
      # 1. 常駐システムプロセスとの通信
      String.contains?(src_str, "group") or String.contains?(tgt_str, "group") or
      String.contains?(src_str, "code_server") or String.contains?(tgt_str, "code_server") or
      String.contains?(src_str, "erlang") or String.contains?(tgt_str, "erlang") or
      String.contains?(src_str, "timer_server") or String.contains?(tgt_str, "timer_server") or
      String.contains?(src_str, "standard_error") or String.contains?(tgt_str, "standard_error") ->
        :system

      # 2. IO / Code ロード
      String.contains?(payload_str, ":io_request") or
      String.contains?(payload_str, ":io_reply") or
      String.contains?(payload_str, ":code_call") or
      String.contains?(payload_str, ":get_object_code") ->
        :system

      # 3. タイマー
      payload_str == ":timeout" or payload_str == "\"timeout\"" or
      String.contains?(payload_str, ":timeout") or
      String.contains?(payload_str, "apply_interval") ->
        :timer

      # 4. OTP 通信
      String.contains?(payload_str, "$gen_call") or
      String.contains?(payload_str, "$gen_cast") or
      String.contains?(payload_str, "$gen_statem") or
      String.contains?(payload_str, ":DOWN") or
      String.contains?(payload_str, ":EXIT") or
      type == "EXIT" ->
        :otp

      # 5. アプリケーションメッセージ
      true ->
        :app
    end
  end

  defp format_term(nil), do: nil
  defp format_term(term), do: inspect(term)

  defp resolve_spawn_payload(child_pid, mfa, resolved_name) do
    cond do
      is_binary(resolved_name) and resolved_name != "[]" and not String.starts_with?(resolved_name, "#PID") ->
        resolved_name

      match?({:proc_lib, :init_p, _}, mfa) ->
        extract_proc_lib_initial_call(child_pid, mfa)

      true ->
        format_mfa(mfa)
    end
  end

  defp extract_proc_lib_initial_call(pid, fallback_mfa) do
    case :proc_lib.translate_initial_call(pid) do
      {mod, _fun, _arity} when is_atom(mod) and mod != :proc_lib ->
        inspect(mod)
      _ ->
        format_mfa(fallback_mfa)
    end
  rescue
    _ -> format_mfa(fallback_mfa)
  end

  defp format_mfa({mod, fun, args}) when is_list(args) do
    "#{inspect(mod)}.#{fun}/#{length(args)}"
  end
  defp format_mfa({mod, fun, arity}) when is_integer(arity) do
    "#{inspect(mod)}.#{fun}/#{arity}"
  end
  defp format_mfa(other), do: inspect(other)

  defp get_process_name(nil), do: nil

  defp get_process_name(pid) when is_pid(pid) do
    case Process.info(pid, :registered_name) do
      {:registered_name, name} when is_atom(name) and name != nil ->
        inspect(name)

      _ ->
        case get_initial_call_from_dict(pid) do
          {mod, _fun, _arity} when is_atom(mod) and mod != :proc_lib ->
            inspect(mod)

          _ ->
            case translate_proc_lib(pid) do
              {mod, _fun, _arity} when is_atom(mod) and mod != :proc_lib ->
                inspect(mod)

              _ ->
                fallback_to_initial_call(pid)
            end
        end
    end
  rescue
    _ -> inspect(pid)
  end

  defp get_process_name(name), do: inspect(name)

  defp get_initial_call_from_dict(pid) do
    case Process.info(pid, :dictionary) do
      {:dictionary, dict} ->
        case List.keyfind(dict, :"$initial_call", 0) do
          {_, {mod, fun, arity}} -> {mod, fun, arity}
          _ -> nil
        end
      _ -> nil
    end
  rescue
    _ -> nil
  end

  defp translate_proc_lib(pid) do
    :proc_lib.translate_initial_call(pid)
  rescue
    _ -> nil
  end

  defp fallback_to_initial_call(pid) do
    case Process.info(pid, :initial_call) do
      {:initial_call, {mod, _fun, _arity}} when is_atom(mod) and mod != :proc_lib ->
        inspect(mod)
      {:initial_call, {mod, fun, arity}} ->
        "#{inspect(mod)}.#{fun}/#{arity}"
      _ ->
        inspect(pid)
    end
  rescue
    _ -> inspect(pid)
  end

  # --- 状態(State)抽出・動的フック用 ヘルパー関数 ---

  defp ensure_module_traced(pid, state) when is_pid(pid) do
    case get_callback_module(pid) do
      nil -> state
      mod ->
        if MapSet.member?(state.traced_modules, mod) do
          state
        else
          hook_genserver_callbacks(mod)
          %{state | traced_modules: MapSet.put(state.traced_modules, mod)}
        end
    end
  end
  defp ensure_module_traced(_, state), do: state

  defp get_callback_module(pid) do
    case get_initial_call_from_dict(pid) do
      {mod, _, _} when is_atom(mod) and mod != :proc_lib -> mod
      _ ->
        case translate_proc_lib(pid) do
          {mod, _, _} when is_atom(mod) and mod != :proc_lib -> mod
          _ -> nil
        end
    end
  end

  defp hook_genserver_callbacks(mod) do
    match_spec = [{:_, [], [{:message, false}, {:return_trace}]}]
    :erlang.trace_pattern({mod, :init, 1}, match_spec, [:local])
    :erlang.trace_pattern({mod, :handle_cast, 2}, match_spec, [:local])
    :erlang.trace_pattern({mod, :handle_call, 3}, match_spec, [:local])
    :erlang.trace_pattern({mod, :handle_info, 2}, match_spec, [:local])
    :erlang.trace_pattern({mod, :handle_continue, 2}, match_spec, [:local])
    IO.puts("[SystemTracer] Dynamically hooked callbacks for: #{inspect(mod)}")
  end

  defp extract_genserver_state({:noreply, new_state}), do: new_state
  defp extract_genserver_state({:noreply, new_state, _}), do: new_state
  defp extract_genserver_state({:reply, _reply, new_state}), do: new_state
  defp extract_genserver_state({:reply, _reply, new_state, _}), do: new_state
  defp extract_genserver_state({:ok, new_state}), do: new_state
  defp extract_genserver_state({:ok, new_state, _}), do: new_state
  defp extract_genserver_state(_), do: :unknown

  defp physical_clock_for(pid) do
    fn ->
      base_time = System.os_time(:millisecond)
      skew = get_simulated_skew(pid)
      base_time + skew
    end
  end

  defp get_simulated_skew(pid) when is_pid(pid) do
    case Process.info(pid, :dictionary) do
      {:dictionary, dict} -> Keyword.get(dict, :simulated_clock_skew, 0)
      _ -> 0
    end
  rescue
    _ -> 0
  end
  defp get_simulated_skew(_), do: 0
end
