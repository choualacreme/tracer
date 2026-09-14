import Config

# Swoosh（メーラー）の外部通信要件を無効化
config :swoosh, :api_client, false

# Tracer本体のWebサーバー起動設定
config :tracer_backend, TracerBackendWeb.Endpoint,
  adapter: Bandit.PhoenixAdapter, # <-- この1行を追加
  http: [ip: {127, 0, 0, 1}, port: 4000],
  server: true,
  secret_key_base: String.duplicate("a", 64),
  pubsub_server: TracerBackend.PubSub
