defmodule TracerExamples.MixProject do
  use Mix.Project

  def project do
    [
      app: :tracer_examples,
      version: "0.1.0",
      elixir: "~> 1.20",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger]
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:tracer_backend, path: "../tracer_backend"}
    ]
  end
end
