defmodule TracerExamples.HlcSkewRunner do
  @moduledoc """
  物理時計のスキュー（遅延）シミュレーション
  """

  def run do
    parent = self()

    # IEx自身ではなく、テスト実行専用のマスタープロセスを立ち上げる
    scenario_runner = spawn(fn ->
      # このプロセスをトレース起点にする
      TracerBackend.SystemTracer.trace_tree(self())
      Process.sleep(50)

      # 1. 物理時計が 1000ms 遅れている Worker B
      worker_b = spawn(fn ->
        Process.put(:simulated_clock_skew, -1000)
        loop_worker_b()
      end)
      Process.register(worker_b, :worker_b)

      # 2. 通常時計の Worker A
      worker_a = spawn(fn ->
        loop_worker_a(worker_b)
      end)
      Process.register(worker_a, :worker_a)

      Process.sleep(100)

      # 3. Worker A にタスクを投げる
      send(worker_a, {:process_task, "Data-X", self()})

      receive do
        {:test_completed, status} ->
          send(parent, {:scenario_finished, status})
      after
        3000 ->
          send(parent, {:scenario_finished, :timeout})
      end
    end)
    Process.register(scenario_runner, :scenario_runner)

    receive do
      {:scenario_finished, status} ->
        IO.puts("\n=== Scenario Finished: #{inspect(status)} ===\n")
    end
  end

  defp loop_worker_a(worker_b) do
    receive do
      {:process_task, data, client_pid} ->
        Process.sleep(100)
        send(worker_b, {:forwarded_task, data, client_pid})
        loop_worker_a(worker_b)
    end
  end

  defp loop_worker_b do
    receive do
      {:forwarded_task, _data, client_pid} ->
        Process.sleep(100)
        send(client_pid, {:test_completed, "Success"})
        loop_worker_b()
    end
  end
end
