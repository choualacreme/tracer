defmodule TracerWebWeb.TraceChannel do
  use TracerWebWeb, :channel

  @doc """
  フロントエンドが "trace_events:lobby" に接続してきた際の初期化処理。
  """
  @impl true
  def join("trace_events:lobby", _payload, socket) do
    # チャンネルのプロセス自身を、SystemTracerのPubSubに購読（Subscribe）させる
    Phoenix.PubSub.subscribe(TracerWeb.PubSub, "trace_events")

    {:ok, socket}
  end

  @doc """
  SystemTracer から PubSub 経由でデータ（JSON）が届いた際の処理。
  """
  @impl true
  def handle_info({:trace, event_data}, socket) do
    # 受け取ったデータを "new_trace_event" というイベント名でWebSocket経由でフロントエンドにプッシュ送信する
    push(socket, "new_trace_event", event_data)

    {:noreply, socket}
  end
end
