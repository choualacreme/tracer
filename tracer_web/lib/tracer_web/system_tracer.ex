defmodule SystemTracer do
  @moduledoc """
  アクターモデルシステム向けの透過的なトレーシング機構．
  Erlang VMの組み込みトレーシング機能を利用して，
  ライフサイクルイベントやプロセス間通信（IPC）をキャプチャし，
  トレースイベントにリアルタイムでHybrid Logical Clocks (HLC) を割り当てる．
  """
  use GenServer

  @doc """
  GenServerとしてSystemTracerを起動する．
  """
  def start_link(_) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  @doc """
  指定されたスーパーバイザーやその子プロセスにトレースフラグを適用する．
  """
  def trace_tree(supervisor_pid) do
    GenServer.call(__MODULE__, {:trace_tree, supervisor_pid})
  end

  # --- Callbacks ---

  @impl GenServer
  def init(_) do
    # $O(1)$ のクロック状態管理のために ETS テーブルを初期化
    :ets.new(:clock_storage, [:named_table, :public, :set])
    IO.puts("[SystemTracer] Initialized in-memory clock storage.")
    {:ok, %{}}
  end

  @impl GenServer
  def handle_call({:trace_tree, target_pid}, _from, state) do
    initial_clock =
      TracerWeb.HLC.new()
      |> TracerWeb.HLC.send()

    :ets.insert(:clock_storage, {target_pid, initial_clock})

    # スーパーバイザーツリー監視のためのトレースフラグ設定
    :erlang.trace(target_pid, true, [:send, :receive, :procs, :set_on_spawn])

    IO.puts("[SystemTracer] Trace attached to node: #{inspect(target_pid)} and its descendants.")
    {:reply, :ok, state}
  end

  # --- Trace Event Handlers ---

  @impl GenServer
  def handle_info({:trace, parent_pid, :spawn, child_pid, _mfa}, state) do
    parent_clock = get_clock(parent_pid)
    new_parent_clock = TracerWeb.HLC.send(parent_clock)
    :ets.insert(:clock_storage, {parent_pid, new_parent_clock})

    child_clock = TracerWeb.HLC.send(new_parent_clock)
    :ets.insert(:clock_storage, {child_pid, child_clock})

    broadcast_event("SPAWN", parent_pid, child_pid, nil, child_clock)

    IO.puts("[EVENT: SPAWN] Parent: #{inspect(parent_pid)} -> Child: #{inspect(child_pid)}")
    {:noreply, state}
  end

  @impl GenServer
  def handle_info({:trace, sender, :send, payload, receiver}, state) do
    sender_clock = get_clock(sender)
    new_clock = TracerWeb.HLC.send(sender_clock)
    :ets.insert(:clock_storage, {sender, new_clock})

    broadcast_event("SEND", sender, receiver, payload, new_clock)

    IO.puts("[EVENT: SEND] #{inspect(sender)} -> #{inspect(receiver)} | Payload: #{inspect(payload)}")
    {:noreply, state}
  end

  @impl GenServer
  def handle_info({:trace, receiver, :receive, payload}, state) do
    receiver_clock = get_clock(receiver)
    # Erlangの透過的なトレース機構ではペイロードから送信元の時計を抽出できないため、ローカルイベントとしてカウントを進行させる
    new_clock = TracerWeb.HLC.send(receiver_clock)
    :ets.insert(:clock_storage, {receiver, new_clock})

    broadcast_event("RECEIVE", receiver, nil, payload, new_clock)

    IO.puts("[EVENT: RECEIVE] #{inspect(receiver)} | Payload: #{inspect(payload)}")
    {:noreply, state}
  end

  @impl GenServer
  def handle_info({:trace, pid, :exit, reason}, state) do
    clock = get_clock(pid)
    broadcast_event("EXIT", pid, nil, reason, clock)

    IO.puts("[EVENT: EXIT] #{inspect(pid)} | Reason: #{inspect(reason)}")
    {:noreply, state}
  end

  # 関連のないトレースイベントのキャッチオール
  @impl GenServer
  def handle_info({:trace, _, _, _}, state), do: {:noreply, state}
  def handle_info({:trace, _, _, _, _}, state), do: {:noreply, state}

  # --- Helper Functions ---

  @doc false
  defp get_clock(pid) do
    case :ets.lookup(:clock_storage, pid) do
      [{^pid, clock}] -> clock
      [] -> TracerWeb.HLC.new()
    end
  end

  @doc false
  defp broadcast_event(type, source, target, payload, clock) do
    event_data = %{
      type: type,
      source: format_term(source),
      target: format_term(target),
      payload: format_term(payload),
      clock: TracerWeb.HLC.to_string(clock)
    }

    Phoenix.PubSub.broadcast(TracerWeb.PubSub, "trace_events", {:trace, event_data})
  end

  @doc false
  defp format_term(nil), do: nil
  defp format_term(term), do: inspect(term)
end
