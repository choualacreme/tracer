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
    # 最新の時計を保存するテーブル
    :ets.new(:clock_storage, [:named_table, :public, :set])
    # 飛行中のメッセージの時計を一時保存するテーブル（重複ペイロードに対応するため :bag を指定）
    :ets.new(:inflight_messages, [:named_table, :public, :bag])

    IO.puts("[SystemTracer] Initialized in-memory clock storages.")

    # 【修正】空のMapSetを持たせる
    {:ok, %{traced_modules: MapSet.new()}}
  end

  @impl GenServer
  def handle_call({:trace_tree, target_pid}, _from, state) do
    initial_clock = TracerBackend.HLC.new() |> TracerBackend.HLC.send()
    :ets.insert(:clock_storage, {target_pid, initial_clock})

    # 【修正】:call フラグの追加のみを行う
    :erlang.trace(target_pid, true, [:send, :receive, :procs, :set_on_spawn, :call])

    # ターゲット自身もフックを試みる
    new_state = ensure_module_traced(target_pid, state)

    IO.puts("[SystemTracer] Trace attached to node: #{inspect(target_pid)} and its descendants.")
    {:reply, :ok, new_state}
  end

  # --- Trace Event Handlers ---

  @impl GenServer
  def handle_info({:trace, parent_pid, :spawn, child_pid, _mfa}, state) do
    parent_clock = get_clock(parent_pid)
    new_parent_clock = TracerBackend.HLC.send(parent_clock)
    :ets.insert(:clock_storage, {parent_pid, new_parent_clock})

    child_clock = TracerBackend.HLC.send(new_parent_clock)
    :ets.insert(:clock_storage, {child_pid, child_clock})

    broadcast_event("SPAWN", parent_pid, child_pid, nil, child_clock)
    {:noreply, state}
  end

  @impl GenServer
  def handle_info({:trace, sender, :send, payload, receiver}, state) do
    sender_clock = get_clock(sender)
    new_clock = TracerBackend.HLC.send(sender_clock)
    :ets.insert(:clock_storage, {sender, new_clock})

    # 【追加】受信先PIDとペイロードをキーにして、送信元PIDと送信時の時計を一時保存
    :ets.insert(:inflight_messages, {{receiver, payload}, sender, new_clock})

    broadcast_event("SEND", sender, receiver, payload, new_clock)

    # 【追加】送信元のモジュールを動的にチェック＆フック
    new_state = ensure_module_traced(sender, state)
    {:noreply, new_state}
  end

  @impl GenServer
  def handle_info({:trace, receiver, :receive, payload}, state) do
    receiver_clock = get_clock(receiver)

    # 【追加】自身宛の当該ペイロードを持つインフライトメッセージを検索
    {new_clock, sender_pid} =
      case :ets.lookup(:inflight_messages, {receiver, payload}) do
        [record | _] ->
          # レコードを展開: {{receiver, payload}, sender, msg_clock}
          {_, sender, msg_clock} = record

          # メモリリーク防止のため、使用したレコードを削除
          :ets.delete_object(:inflight_messages, record)

          # HLC.receive/2 を使用して因果律を同期
          {TracerBackend.HLC.receive(receiver_clock, msg_clock), sender}

        [] ->
          # トレーサー起動前からのメッセージなど、捕捉できなかった場合のフォールバック
          {TracerBackend.HLC.send(receiver_clock), nil}
      end

    :ets.insert(:clock_storage, {receiver, new_clock})

    # senderが特定できた場合は、targetに表示する（逆引き表現）
    broadcast_event("RECEIVE", receiver, sender_pid, payload, new_clock)

    # 【追加】受信先のモジュールを動的にチェック＆フック
    new_state = ensure_module_traced(receiver, state)
    {:noreply, new_state}
  end

  @impl GenServer
  def handle_info({:trace, pid, :exit, reason}, state) do
    clock = get_clock(pid)
    broadcast_event("EXIT", pid, nil, reason, clock)
    {:noreply, state}
  end

  # 【修正】関数の戻り値をキャプチャし、ローカルイベントとして時計を進める
  @impl GenServer
  def handle_info({:trace, pid, :return_from, {_mod, fun, _arity}, return_val}, state)
      when fun in [:init, :handle_cast, :handle_call, :handle_info, :handle_continue] do

    case extract_genserver_state(return_val) do
      :unknown -> :ok
      new_state_val ->
        # 現在の時計を取得し、ローカルイベントとして時計を進める（HLC.sendを流用）
        current_clock = get_clock(pid)
        new_clock = TracerBackend.HLC.send(current_clock)
        :ets.insert(:clock_storage, {pid, new_clock})

        broadcast_event("LOCAL EVENT", pid, nil, new_state_val, new_clock)
    end
    {:noreply, state}
  end

  # 【追加】:callフラグによる副作用イベント（呼び出し自体）は無視
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

  defp broadcast_event(type, source, target, payload, clock) do
    event_data = %{
      type: type,
      source: format_term(source),
      source_name: get_process_name(source),
      target: format_term(target),
      target_name: get_process_name(target),
      payload: format_term(payload),
      clock: TracerBackend.HLC.to_string(clock)
    }

    Phoenix.PubSub.broadcast(
      TracerBackend.PubSub,
      "trace_events:lobby",
      {:new_trace_event, event_data}
    )
  end

  defp format_term(nil), do: nil
  defp format_term(term), do: inspect(term)

  # 【追加】nilの場合はそのままnilを返し、"nil"という文字列化を防ぐ
  defp get_process_name(nil), do: nil

  defp get_process_name(pid) when is_pid(pid) do
    # 1. 登録名を確認（Erlang仕様で未登録時は [] が返るため厳密にマッチさせる）
    case Process.info(pid, :registered_name) do
      {:registered_name, name} ->
        inspect(name)

      _ ->
        # 2. GenServer等の実際のモジュール名を辞書から探す
        case Process.info(pid, :dictionary) do
          {:dictionary, dict} ->
            case List.keyfind(dict, :"$initial_call", 0) do
              {_, {mod, _fun, _arity}} -> inspect(mod)
              _ -> fallback_to_initial_call(pid)
            end
          _ -> fallback_to_initial_call(pid)
        end
    end
  end

  defp get_process_name(name), do: inspect(name)

  # 3. 完全な無名プロセス (spawn等) は、最初に実行した関数名を抽出する
  defp fallback_to_initial_call(pid) do
    case Process.info(pid, :initial_call) do
      {:initial_call, {mod, fun, arity}} -> "#{inspect(mod)}.#{fun}/#{arity}"
      _ -> inspect(pid)
    end
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

  # 内部辞書から対象PIDの実体モジュールを取得する
  defp get_callback_module(pid) do
    case Process.info(pid, :dictionary) do
      {:dictionary, dict} ->
        case List.keyfind(dict, :"$initial_call", 0) do
          {_, {mod, _, _}} when is_atom(mod) -> mod
          _ -> nil
        end
      _ -> nil
    end
  end

  # 指定された単一のモジュールに対してのみ、戻り値のトレースパターンを適用する
  defp hook_genserver_callbacks(mod) do
    match_spec = [{:_, [], [{:message, false}, {:return_trace}]}]
    :erlang.trace_pattern({mod, :init, 1}, match_spec, [:local])
    :erlang.trace_pattern({mod, :handle_cast, 2}, match_spec, [:local])
    :erlang.trace_pattern({mod, :handle_call, 3}, match_spec, [:local])
    :erlang.trace_pattern({mod, :handle_info, 2}, match_spec, [:local])
    :erlang.trace_pattern({mod, :handle_continue, 2}, match_spec, [:local])
    IO.puts("[SystemTracer] Dynamically hooked callbacks for: #{inspect(mod)}")
  end

  # GenServerの戻り値タプルから新しいStateを抽出
  defp extract_genserver_state({:noreply, new_state}), do: new_state
  defp extract_genserver_state({:noreply, new_state, _}), do: new_state
  defp extract_genserver_state({:reply, _reply, new_state}), do: new_state
  defp extract_genserver_state({:reply, _reply, new_state, _}), do: new_state
  defp extract_genserver_state({:ok, new_state}), do: new_state
  defp extract_genserver_state({:ok, new_state, _}), do: new_state
  defp extract_genserver_state(_), do: :unknown
end
