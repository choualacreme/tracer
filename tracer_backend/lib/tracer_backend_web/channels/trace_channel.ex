defmodule TracerBackendWeb.TraceChannel do
  use TracerBackendWeb, :channel

  # intercept と handle_out はまるごと削除

  def join("trace_events:lobby", _payload, socket) do
    {:ok, socket}
  end

  # SystemTracerからのイベントを受信し、ここで1回だけ整形して全員にブロードキャスト
  def handle_info({:new_trace_event, payload}, socket) do
    safe_payload = %{
        "type" => to_safe_string(payload[:type] || payload["type"] || "unknown"),
        "source" => to_safe_string(payload[:source] || payload["source"]),
        "target" => format_target(payload[:target] || payload["target"]),
        "clock" => payload[:clock] || payload["clock"]
    }

    broadcast!(socket, "new_trace_event", safe_payload)
    {:noreply, socket}
  end

  # --- ヘルパー関数（そのまま残す） ---
  defp to_safe_string(nil), do: ""
  defp to_safe_string(val) when is_binary(val), do: val
  defp to_safe_string(val) when is_atom(val), do: Atom.to_string(val)
  defp to_safe_string(val), do: inspect(val)

  defp format_target(nil), do: nil
  defp format_target(""), do: nil
  defp format_target(val), do: to_safe_string(val)
end
