defmodule TracerBackendWeb.PageController do
  use TracerBackendWeb, :controller

  def home(conn, _params) do
    render(conn, :home)
  end
end
