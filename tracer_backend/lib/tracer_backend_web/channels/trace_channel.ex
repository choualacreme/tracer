defmodule TracerBackendWeb.TraceChannel do
  use TracerBackendWeb, :channel

  def join("trace_events:lobby", _payload, socket) do
    {:ok, socket}
  end

  def handle_info({:new_trace_event, payload}, socket) do
    safe_payload = %{
        "type" => to_safe_string(payload[:type] || payload["type"] || "unknown"),
        "source" => to_safe_string(payload[:source] || payload["source"]),
        "source_name" => to_safe_string(payload[:source_name] || payload["source_name"]), # 【追加】
        "target" => format_target(payload[:target] || payload["target"]),
        "target_name" => format_target(payload[:target_name] || payload["target_name"]), # 【追加】
        "payload" => format_target(payload[:payload] || payload["payload"]), # 【追加】
        "clock" => payload[:clock] || payload["clock"]
    }

    broadcast!(socket, "new_trace_event", safe_payload)
    {:noreply, socket}
  end
  # --- ヘルパー関数 ---
  defp to_safe_string(nil), do: ""
  defp to_safe_string(val) when is_binary(val), do: val
  defp to_safe_string(val) when is_atom(val), do: Atom.to_string(val)
  defp to_safe_string(val), do: inspect(val)

  defp format_target(nil), do: nil
  defp format_target(""), do: nil
  defp format_target(val), do: to_safe_string(val)
end
