defmodule MockPlant.Supervisor do
  @moduledoc "発電所モックの現場監督"
  use Supervisor

  def start_link(_) do
    Supervisor.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @impl true
  def init(:ok) do
    children = [
      MockPlant.Sensor,
      MockPlant.Controller,
      MockPlant.Turbine
    ]

    # :rest_for_one 戦略
    # Controllerが死んだ場合、後続のTurbineも強制終了して綺麗な状態で再起動させる
    Supervisor.init(children, strategy: :rest_for_one)
  end
end

defmodule MockPlant.Sensor do
  @moduledoc "温度センサー（データの発生源）"
  use GenServer

  def start_link(_), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @impl true
  def init(:ok), do: {:ok, %{}}

  # 外部から「正常なデータを送れ」と指示された時
  @impl true
  def handle_cast(:send_normal, state) do
    send(MockPlant.Controller, {:temperature, 80})
    {:noreply, state}
  end

  # 外部から「異常なノイズデータを送れ」と指示された時
  @impl true
  def handle_cast(:inject_noise, state) do
    # 意図的に想定外のデータ型（文字列など）を送りつける
    send(MockPlant.Controller, {:temperature, "ERROR_NOISE"})
    {:noreply, state}
  end
end

defmodule MockPlant.Controller do
  @moduledoc "制御装置"
  use GenServer

  def start_link(_), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @impl true
  def init(:ok), do: {:ok, %{}}

  @impl true
  def handle_info({:temperature, temp}, state) do
    # もし temp が数値なら正常に計算できるが、文字列だと ArithmeticError でクラッシュする
    safe_limit = temp / 2

    send(MockPlant.Turbine, {:set_speed, safe_limit})
    {:noreply, state}
  end
end

defmodule MockPlant.Turbine do
  @moduledoc "タービン"
  use GenServer

  def start_link(_), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @impl true
  def init(:ok), do: {:ok, %{}}

  @impl true
  def handle_info({:set_speed, speed}, state) do
    IO.puts("🏭 タービン: 回転数を #{speed} に設定しました。")
    {:noreply, state}
  end
end
