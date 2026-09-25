defmodule TracerBackendWeb.TraceChannel do
  use TracerBackendWeb, :channel

  def join("trace_events:lobby", _payload, socket) do
    {:ok, socket}
  end

  # PubSub から受け取ったアトムマップをそのままクライアントへ配信
  def handle_info({:new_trace_event, payload}, socket) do
    broadcast!(socket, "new_trace_event", payload)
    {:noreply, socket}
  end
end
