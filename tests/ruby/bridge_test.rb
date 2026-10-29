# Plain Ruby test of the bridge LOOP with a fake SketchUp:   ruby tests/ruby/bridge_test.rb
# Covers: queue folders, claiming files, JSON handling, whitelist, model guard,
# master protection, undo wrapping, duplicates, heartbeat.
# It does NOT test real geometry - that needs SketchUp on Windows (npm run smoke).
require 'json'
require 'tmpdir'
require 'fileutils'
require 'minitest/autorun'

# ---------- the smallest fake SketchUp that main.rb needs ----------
module UI
  def self.start_timer(*_a); :timer; end
  def self.stop_timer(*_a); nil; end
  def self.menu(*_a); FakeMenu.new; end
  def self.messagebox(*_a); nil; end
  def self.openURL(*_a); nil; end
end

class FakeMenu
  def add_submenu(*_a); self; end
  def add_item(*_a); nil; end
end

class FakeList
  include Enumerable
  def initialize(items); @items = items; end
  def each(&block); @items.each(&block); end
  def [](name); @items.find { |i| i.name == name }; end
end

FakeNamed = Struct.new(:name) do
  def visible?; true; end
end

class FakeBounds
  def empty?; true; end
end

class FakeModel
  attr_accessor :path, :ops
  def initialize(path); @path = path; @ops = []; end
  def title; File.basename(@path, '.skp'); end
  def entities; []; end
  def materials; FakeList.new([FakeNamed.new('UMD Light Oak')]); end
  def layers; FakeList.new([FakeNamed.new('Layer0')]); end
  def pages; FakeList.new([]); end
  def definitions; FakeList.new([]); end
  def bounds; FakeBounds.new; end
  def start_operation(name, *_a); @ops << [:start, name]; end
  def commit_operation; @ops << [:commit]; end
  def abort_operation; @ops << [:abort]; end
end

module Sketchup
  class Group; end
  class ComponentInstance; end
  class ComponentDefinition; end
  class << self
    attr_accessor :active_model
  end
  def self.version; '25.0.634'; end
  def self.is_pro?; true; end
end

def file_loaded?(*_a); false; end
def file_loaded(*_a); nil; end

load File.join(__dir__, '..', '..', 'sketchup', 'umd_bridge', 'main.rb')

# ---------- tests ----------
class BridgeLoopTest < Minitest::Test
  DEV = 'E:/Cowork_Field/Thesis_SketchUp/dev/UMD_DEV_1F.skp'
  MASTER = 'E:/Cowork_Field/Thesis_SketchUp/Urban_Mind_Detox_MASTER_Presentation_Scenes_v01.skp'

  def setup
    @dir = Dir.mktmpdir('umd-bridge-')
    Sketchup.active_model = FakeModel.new(DEV)
    UMDBridge.instance_variable_set(:@timer, nil)
    UMDBridge.boot(@dir, auto_start: true)
    File.write(File.join(@dir, 'target.txt'), "UMD_DEV_\n")
  end

  def teardown
    UMDBridge.stop
    FileUtils.rm_rf(@dir)
  end

  def send_cmd(tool, args = {}, id: "20261103-000000-#{rand(16**6).to_s(16).rjust(6, '0')}", version: 1, raw: nil)
    File.write(File.join(@dir, 'in', "#{id}.json"), raw || JSON.generate('id' => id, 'version' => version, 'tool' => tool, 'args' => args, 'createdAt' => '2026-11-03T10:00:00+07:00'))
    UMDBridge.tick
    out = File.join(@dir, 'out', "#{id}.json")
    assert File.exist?(out), 'bridge did not answer'
    JSON.parse(File.read(out))
  end

  def test_ping_answers_and_moves_the_command_to_done
    r = send_cmd('ping', id: 'ping-000001')
    assert r['ok']
    assert_equal '25.0.634', r['data']['sketchupVersion']
    assert_includes r['data']['tools'], 'createBox'
    assert File.exist?(File.join(@dir, 'done', 'ping-000001.json'))
    refute File.exist?(File.join(@dir, 'in', 'ping-000001.json'))
  end

  def test_writes_a_heartbeat
    UMDBridge.instance_variable_set(:@last_beat, Time.at(0))
    UMDBridge.tick
    beat = JSON.parse(File.read(File.join(@dir, 'heartbeat.json')))
    assert_equal DEV, beat['modelPath']
  end

  def test_unknown_tool_is_refused
    assert_equal 'UNKNOWN_TOOL', send_cmd('eval_ruby', { 'code' => '1+1' })['error']['code']
  end

  def test_extra_arguments_are_refused
    assert_equal 'INVALID_ARGS', send_cmd('ping', { 'ruby' => 'x' })['error']['code']
  end

  def test_broken_json_is_answered_not_crashed
    r = send_cmd(nil, id: 'broken-0001', raw: '{ not json')
    assert_equal 'BAD_COMMAND', r['error']['code']
  end

  def test_id_must_match_file_name
    r = send_cmd(nil, id: 'file-name-01', raw: JSON.generate('id' => 'other-id-01', 'version' => 1, 'tool' => 'ping', 'args' => {}))
    assert_equal 'BAD_COMMAND', r['error']['code']
  end

  def test_protocol_version_is_checked
    assert_equal 'VERSION_MISMATCH', send_cmd('ping', version: 2)['error']['code']
  end

  def test_changing_tools_need_target_txt
    File.delete(File.join(@dir, 'target.txt'))
    r = send_cmd('createBox', { 'jobGroup' => 'j', 'name' => 'b', 'tag' => 't', 'min' => [0, 0, 0], 'max' => [1, 1, 1] })
    assert_equal 'WRONG_MODEL', r['error']['code']
    assert_empty Sketchup.active_model.ops, 'no undo operation should even start'
  end

  def test_wrong_model_is_refused
    Sketchup.active_model = FakeModel.new('E:/Other/Project.skp')
    r = send_cmd('saveCopy', { 'fileName' => 'x.skp' })
    assert_equal 'WRONG_MODEL', r['error']['code']
  end

  def test_master_is_protected_even_if_target_txt_matches_it
    Sketchup.active_model = FakeModel.new(MASTER)
    File.write(File.join(@dir, 'target.txt'), 'Urban_Mind')
    r = send_cmd('createBox', { 'jobGroup' => 'j', 'name' => 'b', 'tag' => 't', 'min' => [0, 0, 0], 'max' => [1, 1, 1] })
    assert_equal 'MASTER_PROTECTED', r['error']['code']
  end

  def test_read_tools_work_on_the_master
    Sketchup.active_model = FakeModel.new(MASTER)
    assert send_cmd('getModelInfo')['ok']
  end

  def test_a_failing_write_tool_is_rolled_back
    # No Geom in the fake, so createBox fails inside the undo step -> must abort, not commit.
    r = send_cmd('createBox', { 'jobGroup' => 'j', 'name' => 'b', 'tag' => 't', 'min' => [0, 0, 0], 'max' => [1, 1, 1] })
    refute r['ok']
    assert_equal [:start, :abort], Sketchup.active_model.ops.map(&:first)
  end

  def test_a_command_is_never_run_twice
    id = 'dup-000001'
    FileUtils.mkdir_p(File.join(@dir, 'out'))
    File.write(File.join(@dir, 'out', "#{id}.json"), '{"already":"answered"}')
    File.write(File.join(@dir, 'in', "#{id}.json"), JSON.generate('id' => id, 'version' => 1, 'tool' => 'ping', 'args' => {}))
    UMDBridge.tick
    assert_equal({ 'already' => 'answered' }, JSON.parse(File.read(File.join(@dir, 'out', "#{id}.json"))))
  end

  def test_one_command_per_tick_keeps_sketchup_responsive
    %w[aaaaaa-0001 aaaaaa-0002].each do |id|
      File.write(File.join(@dir, 'in', "#{id}.json"), JSON.generate('id' => id, 'version' => 1, 'tool' => 'ping', 'args' => {}))
    end
    UMDBridge.tick
    assert File.exist?(File.join(@dir, 'out', 'aaaaaa-0001.json'))
    refute File.exist?(File.join(@dir, 'out', 'aaaaaa-0002.json'))
    UMDBridge.tick
    assert File.exist?(File.join(@dir, 'out', 'aaaaaa-0002.json'))
  end

  def test_every_command_is_logged
    send_cmd('ping', id: 'log-000001')
    lines = File.readlines(File.join(@dir, 'bridge_log.jsonl')).map { |l| JSON.parse(l) }
    assert(lines.any? { |l| l['id'] == 'log-000001' && l['event'] == 'done' && l['ok'] == true })
  end
end
