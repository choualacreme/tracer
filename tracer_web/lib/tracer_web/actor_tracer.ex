defmodule ActorTracer do
  @moduledoc """
  アクターモデルの因果関係トレーサーのメインAPI
  """

  @doc """
  トレーサーシステム全体を起動する．
  """
  def start() do
    SystemTracer.start_link(nil)
  end

  @doc """
  指定したスーパーバイザーとその配下全員の監視を開始する．
  """
  def trace_tree(supervisor_pid) do
    SystemTracer.trace_tree(supervisor_pid)
  end

end
