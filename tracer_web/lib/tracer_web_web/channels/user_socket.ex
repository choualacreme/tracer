defmodule TracerWebWeb.UserSocket do
  use Phoenix.Socket

  # "trace_events:" から始まる通信を TraceChannel にルーティングする
  channel "trace_events:*", TracerWebWeb.TraceChannel

  @impl true
  def connect(_params, socket, _connect_info) do
    # 認証処理などは不要なため、すべて無条件で接続を許可する
    {:ok, socket}
  end

  @impl true
  def id(_socket), do: nil
end
