defmodule TracerExamples.Evaluation.Worker do
  @moduledoc "評価シナリオ用のダミーワーカー"
  use GenServer

  def start_link(id) do
    GenServer.start_link(__MODULE__, id)
  end

  @impl true
  def init(id) do
    {:ok, %{id: id, count: 0}}
  end

  @impl true
  def handle_cast({:process_data, _payload}, state) do
    # 意図的にシステム内部のノイズ（:io_request 等）を発生させる
    IO.write("")
    {:noreply, %{state | count: state.count + 1}}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, {:ok, state.count}, state}
  end
end

defmodule TracerExamples.Evaluation.Runner do
  @moduledoc """
  論文評価用テストシナリオ
  """

  @doc """
  Massive Parallel & Microsecond Burst シナリオ
  """
  def run(worker_count \\ 100) do
    IO.puts("=== Starting Evaluation Scenario (#{worker_count} workers) ===")

    # 1. 監視ツリー（Supervisor）の立ち上げ
    {:ok, sup} = Supervisor.start_link([], strategy: :one_for_one, name: EvaluationSupervisor)

    # 2. SystemTracer を Supervisor にアタッチ
    TracerBackend.SystemTracer.trace_tree(sup)

    # 3. 大量プロセスの起動 (Spawn Burst)
    # これにより「Poolグループ化機能」のパフォーマンスを評価します
    workers =
      Enum.map(1..worker_count, fn i ->
        {:ok, pid} =
          Supervisor.start_child(sup, %{
            id: {TracerExamples.Evaluation.Worker, i},
            start: {TracerExamples.Evaluation.Worker, :start_link, [i]},
            restart: :temporary
          })
        pid
      end)

    IO.puts("[Phase 1] #{length(workers)} workers spawned.")
    Process.sleep(500)

    # 4. 同一ミリ秒での一斉送信 (Message Burst)
    # Elixirの処理速度により物理時間(PT)が同じイベントが大量発生します
    IO.puts("[Phase 2] Broadcasting messages in a microsecond burst...")
    Enum.each(workers, fn pid ->
      GenServer.cast(pid, {:process_data, "evaluation_payload"})
    end)

    Process.sleep(500)

    # 5. 状態の同期取得 (OTP Call)
    IO.puts("[Phase 3] Syncing status (Generating OTP Noise)...")
    Enum.each(workers, fn pid ->
      GenServer.call(pid, :get_status)
    end)

    Process.sleep(500)

    # 6. クリーンアップ
    Supervisor.stop(sup)
    IO.puts("=== Evaluation Scenario Completed ===")
  end
end
