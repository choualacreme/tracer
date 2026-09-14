defmodule TracerExamplesTest do
  use ExUnit.Case
  doctest TracerExamples

  test "greets the world" do
    assert TracerExamples.hello() == :world
  end
end
