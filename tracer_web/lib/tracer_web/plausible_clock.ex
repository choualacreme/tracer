defmodule PlausibleClock do
  @moduledoc """
  アクターシステム向けのPlausible Clocksの実装．
  無限大に増大することを避けつつ，'happens-before（先行）'関係を確率的に評価するための
  固定長ベクトルクロックを提供する．
  An implementation of Plausible Clocks for actor systems.
  Provides a fixed-length vector clock to probabilistically evaluate
  the 'happens-before' relationship while avoiding unbounded growth.
  """

  @k 64 # Fixed length of the tuple

  @doc """
  ゼロで初期化された新しいクロックを生成する．
  Initializes a new zero-filled clock.
  """
  def new(), do: :erlang.make_tuple(@k, 0)

  @doc """
  指定したプロセス識別子のクロックをインクリメントする．
  Increments the clock for a given process identifier.
  Maps the identifier to an index [0, k-1] using a hash function.
  """
  def increment(clock, pid_or_id) do
    index = :erlang.phash2(pid_or_id, @k)
    current_val = elem(clock, index)
    put_elem(clock, index, current_val + 1)
  end

  @doc """
  二つのクロックをマージする．
  Merges two clocks by taking the pairwise maximum of their components.
  """
  def merge(clock_a, clock_b) do
    list_a = Tuple.to_list(clock_a)
    list_b = Tuple.to_list(clock_b)

    Enum.zip_with(list_a, list_b, fn a, b -> max(a, b) end)
    |> List.to_tuple()
  end

  @doc """
  二つのクロックを比較し，因果関係を決定する．
  Compares two clocks to determine their causal relationship.
  Returns :happens_before, :happens_after, :equal, or :concurrent.
  """
  def compare(clock_a, clock_b) do
    a_le_b? = less_than_or_equal?(clock_a, clock_b)
    b_le_a? = less_than_or_equal?(clock_b, clock_a)

    case {a_le_b?, b_le_a?} do
      {true, true}   -> :equal
      {true, false}  -> :happens_before
      {false, true}  -> :happens_after
      {false, false} -> :concurrent
    end
  end

  # --- Helper Functions ---

  @doc false
  defp less_than_or_equal?(clock_a, clock_b) do
    list_a = Tuple.to_list(clock_a)
    list_b = Tuple.to_list(clock_b)
    Enum.zip(list_a, list_b) |> Enum.all?(fn {a, b} -> a <= b end)
  end
end
