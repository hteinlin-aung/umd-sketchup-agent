# Plain Ruby test, no SketchUp needed:   ruby tests/ruby/args_test.rb
# Checks the Ruby validators against the same cases as tests/unit/argsParity.test.ts.
require 'json'
require 'minitest/autorun'
require_relative '../../sketchup/umd_bridge/args'

class ArgsParityTest < Minitest::Test
  CASES = JSON.parse(File.read(File.join(__dir__, '..', 'fixtures', 'args_cases.json')))

  CASES.each_with_index do |c, i|
    define_method("test_case_#{i}_#{c['tool']}_#{c['valid'] ? 'valid' : 'invalid'}") do
      ok =
        begin
          UMDBridge::Validate.public_send(c['tool'], c['args'])
          true
        rescue UMDBridge::ToolError => e
          assert_equal 'INVALID_ARGS', e.code
          false
        end
      assert_equal c['valid'], ok, "#{c['tool']} #{c['args'].to_json}"
    end
  end

  def test_defaults_are_filled_in
    v = UMDBridge::Validate.applyMaterial('target' => { 'entityId' => 1 }, 'material' => 'm')
    assert_equal 'all', v['faces']
    assert_equal false, v['paintBack']
    assert_equal 1600, UMDBridge::Validate.captureView('fileName' => 'a.png')['width']
  end

  def test_names_are_trimmed
    v = UMDBridge::Validate.createBox('jobGroup' => ' j ', 'name' => 'b', 'tag' => 't', 'min' => [0, 0, 0], 'max' => [1, 1, 1])
    assert_equal 'j', v['jobGroup']
  end
end
