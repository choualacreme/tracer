defmodule TracerBackend.HLC do
  @moduledoc """
  Hybrid Logical Clock (HLC) の実装．
  物理時間(pt)と論理カウンター(c)を保持し，O(1)のサイズで因果律をトラッキングする．
  """

  defstruct pt: 0, c: 0

  def default_physical_time do
    System.os_time(:millisecond)
  end

  # 新しい時計の初期化
  def new(clock_fun \\ &default_physical_time/0) do
    %__MODULE__{pt: clock_fun.(), c: 0}
  end

  # ローカルイベントの発生（SENDやSPAWNなど）
  def send(%__MODULE__{pt: pt, c: c}, clock_fun \\ &default_physical_time/0) do
    now = clock_fun.()

    if now > pt do
      %__MODULE__{pt: now, c: 0}
    else
      %__MODULE__{pt: pt, c: c + 1}
    end
  end

  # メッセージ受信時の時計の更新（RECEIVEなど）
  def receive(%__MODULE__{pt: local_pt, c: local_c}, %__MODULE__{pt: msg_pt, c: msg_c}, clock_fun \\ &default_physical_time/0) do
    now = clock_fun.()

    max_pt = Enum.max([now, local_pt, msg_pt])

    new_c = cond do
      max_pt == local_pt and max_pt == msg_pt -> max(local_c, msg_c) + 1
      max_pt == local_pt -> local_c + 1
      max_pt == msg_pt -> msg_c + 1
      true -> 0
    end

    %__MODULE__{pt: max_pt, c: new_c}
  end

  # フロントエンドに送るためのフォーマット変換
  def to_string(%__MODULE__{pt: pt, c: c}) do
    "#{pt}-#{c}"
  end
end
