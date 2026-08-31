defmodule Factory.TestRunner do
  @moduledoc "トレーサーのアタッチと工場ラインの稼働を安全に同期する"

  def run do
    # 1. まずSupervisorを子プロセスなしで起動
    {:ok, sup_pid} = Supervisor.start_link([], strategy: :one_for_one)

    # 2. トレーサーをSupervisorにアタッチ（以降の子プロセスも自動追跡される）
    TracerBackend.SystemTracer.trace_tree(sup_pid)

    # 3. トレース準備が整ってから実際の工場システムをツリーの下にぶら下げる
    Supervisor.start_child(sup_pid, %{
      id: Factory.Supervisor,
      start: {Factory.Supervisor, :start_link, [[]]},
      restart: :temporary
    })

    IO.puts("🚀 生産ラインのトレースを開始しました")
  end
end

defmodule Factory.Storage do
  @moduledoc "完成品を保管する倉庫。目標数に達したらシステムを止める"
  use GenServer

  def start_link(target), do: GenServer.start_link(__MODULE__, target, name: __MODULE__)

  def init(target), do: {:ok, %{count: 0, target: target}}

  def handle_cast({:store, item}, %{count: c, target: t} = state) when c + 1 == t do
    IO.puts("📦 Storage: #{item} を収納 (計 #{c + 1}個)")
    IO.puts("📦 Storage: 目標生産量(#{t}個)に到達。ラインを停止します。")

    spawn(fn ->
      Supervisor.stop(Factory.Supervisor, :normal)
    end)

    {:noreply, %{state | count: c + 1}}
  end

  def handle_cast({:store, item}, state) do
    IO.puts("📦 Storage: #{item} を収納 (計 #{state.count + 1}個)")
    {:noreply, %{state | count: state.count + 1}}
  end
end

defmodule Factory.Assembler do
  @moduledoc "使い捨ての組み立てプロセス。ランダムな時間で処理し、たまに壊れる"
  use GenServer, restart: :temporary

  def start_link(id), do: GenServer.start_link(__MODULE__, id)

  def init(id) do
    # 起動直後に自分自身へ作業開始のメッセージを送る
    send(self(), :process)
    {:ok, %{id: id}}
  end

  def handle_info(:process, state) do
    # 各プロセスが非同期に動いていることを可視化するためのランダムな遅延
    Process.sleep(Enum.random(500..2000))

    if Enum.random(1..5) == 1 do
      # 20%の確率で素材が詰まってクラッシュ（異常終了）
      IO.puts("🔥 Assembler #{state.id}: 異常発生！クラッシュしました。")
      raise "Jam Error"
    else
      # 正常に組み立て完了
      GenServer.cast(Factory.Storage, {:store, "製品-#{state.id}"})
      # 役目を終えたので自発的に終了（トレース上で[EXIT]となりゴースト化する）
      {:stop, :normal, state}
    end
  end
end

defmodule Factory.Producer do
  @moduledoc "一定間隔でAssemblerを動的にSpawnし続ける生産ライン"
  use GenServer

  def start_link(_), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  def init(:ok) do
    # 800ミリ秒ごとに組み立て機を起動
    :timer.send_interval(800, :spawn_assembler)
    {:ok, %{worker_count: 0}}
  end

  def handle_info(:spawn_assembler, state) do
    count = state.worker_count + 1
    IO.puts("🏭 Producer: 組み立て機 #{count} をラインに投入")

    # 動的にプロセスを生成（グラフ上で[SPAWN]イベントとして可視化される）
    DynamicSupervisor.start_child(Factory.WorkerSupervisor, {Factory.Assembler, count})

    {:noreply, %{state | worker_count: count}}
  end
end

defmodule Factory.Supervisor do
  @moduledoc "システム全体の監視ツリー"
  use Supervisor

  def start_link(_) do
    Supervisor.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  def init(:ok) do
    children = [
      {Factory.Storage, 10}, # ここを10や20にすると長時間動きます
      {DynamicSupervisor, name: Factory.WorkerSupervisor, strategy: :one_for_one},
      Factory.Producer
    ]

    # Storageなどが終了したら全て巻き込んで終了する
    Supervisor.init(children, strategy: :one_for_all)
  end
end
