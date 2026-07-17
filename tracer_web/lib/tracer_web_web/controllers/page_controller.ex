defmodule TracerWebWeb.PageController do
  use TracerWebWeb, :controller

  def home(conn, _params) do
    render(conn, :home)
  end
end
