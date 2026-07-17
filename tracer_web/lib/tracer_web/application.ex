defmodule TracerWeb.Application do
  # See https://elixir.hexdocs.pm/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      TracerWebWeb.Telemetry,
      {DNSCluster, query: Application.get_env(:tracer_web, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: TracerWeb.PubSub},
      # Start a worker by calling: TracerWeb.Worker.start_link(arg)
      # {TracerWeb.Worker, arg},
      # Start to serve requests, typically the last entry
      TracerWebWeb.Endpoint,

      # Start the system tracer
      SystemTracer
    ]

    # See https://elixir.hexdocs.pm/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: TracerWeb.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    TracerWebWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
