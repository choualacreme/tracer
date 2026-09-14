defmodule TracerBackendWeb.PageController do
  use TracerBackendWeb, :controller

  def index(conn, _params) do
    conn
    |> put_resp_header("content-type", "text/html; charset=utf-8")
    |> send_file(200, Application.app_dir(:tracer_backend, "priv/static/index.html"))
  end
end
