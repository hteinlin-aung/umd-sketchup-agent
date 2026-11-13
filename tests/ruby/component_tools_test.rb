# Plain Ruby test of the components folder rules (Week 3):   ruby tests/ruby/component_tools_test.rb
# Covers WHICH files the bridge will touch: only plain .skp names inside <queue's parent>/components,
# and nothing over the size limit. Loading and placing real geometry is tested on Windows.
require 'minitest/autorun'
require 'tmpdir'
require 'fileutils'
require_relative 'fake_sketchup'

class ComponentToolsTest < Minitest::Test
  def setup
    @root = Dir.mktmpdir('umd-comp-')
    @queue = File.join(@root, 'agent_queue')
    @comp = File.join(@root, 'components')
    FileUtils.mkdir_p([@queue, @comp])
    File.write(File.join(@comp, '3DW_Banyan tree.skp'), 'x' * 10)
    File.write(File.join(@comp, '3DW_Mercy S curved boucle sofa.skp'), 'x' * 20)
    File.write(File.join(@comp, 'notes.txt'), 'not a component')
    FileUtils.mkdir_p(File.join(@comp, 'old'))
    File.write(File.join(@root, 'outside.skp'), 'x')
    @ctx = { queue_dir: @queue, warnings: [] }
  end

  def teardown
    FileUtils.rm_rf(@root)
  end

  def test_the_folder_is_next_to_the_queue_folder
    assert_equal File.join(@root, 'components'), UMDBridge::Tools.components_dir(@ctx)
  end

  def test_lists_only_skp_files_in_that_folder
    data = UMDBridge::Tools.listComponents({}, @ctx)
    assert_equal ['3DW_Banyan tree.skp', '3DW_Mercy S curved boucle sofa.skp'], data['files'].map { |f| f['file'] }
    assert_equal [10, 20], data['files'].map { |f| f['bytes'] }
  end

  def test_an_empty_list_when_the_folder_does_not_exist
    FileUtils.rm_rf(@comp)
    assert_equal [], UMDBridge::Tools.listComponents({}, @ctx)['files']
  end

  def test_finds_a_file_in_the_folder
    path, bytes = UMDBridge::Tools.component_path(@ctx, '3DW_Banyan tree.skp')
    assert_equal File.expand_path(File.join(@comp, '3DW_Banyan tree.skp')), path
    assert_equal 10, bytes
  end

  def test_refuses_anything_outside_the_folder
    e = assert_raises(UMDBridge::ToolError) { UMDBridge::Tools.component_path(@ctx, '../outside.skp') }
    assert_equal 'INVALID_ARGS', e.code
  end

  def test_a_missing_file_is_not_found
    e = assert_raises(UMDBridge::ToolError) { UMDBridge::Tools.component_path(@ctx, '3DW_Chandelier.skp') }
    assert_equal 'NOT_FOUND', e.code
  end

  def test_refuses_a_file_over_the_size_limit
    big = File.join(@comp, '3DW_Huge.skp')
    File.open(big, 'wb') { |f| f.truncate(UMDBridge::Tools::COMPONENT_MAX_BYTES + 1) }
    e = assert_raises(UMDBridge::ToolError) { UMDBridge::Tools.component_path(@ctx, '3DW_Huge.skp') }
    assert_equal 'INVALID_ARGS', e.code
    assert_match(/limit is 50 MB/, e.message)
  end

  def test_the_bridge_lists_the_new_tools_with_the_right_kinds
    assert_equal :read, UMDBridge.tools['listComponents']
    assert_equal :write, UMDBridge.tools['componentInfo']
    assert_equal :write, UMDBridge.tools['placeComponent']
    assert_equal '0.6.0', UMDBridge.version
    assert_equal :read, UMDBridge.tools['componentPreview']
  end
end

# load_definition with tiny stand-ins for SketchUp's definition list (only what it uses).
class ReuseDefinitionTest < Minitest::Test
  Box = Struct.new(:width, :height, :depth)
  Defn = Struct.new(:name, :guid, :bounds, :instances) do
    def group?; false; end
    def image?; false; end
  end
  class Defs
    attr_reader :list, :removed
    def initialize(list, loads)
      @list = list
      @loads = loads
      @removed = []
    end
    def to_a; @list.dup; end
    def load(_path)
      d = @loads
      @list << d unless @list.include?(d)
      d
    end
    def remove(d)
      @removed << d
      @list.delete(d)
    end
  end
  Model = Struct.new(:definitions)

  def inches(m)
    m / 0.0254
  end

  def fittonia(name, guid)
    Defn.new(name, guid, Box.new(inches(0.29), inches(0.27), inches(0.1)), [])
  end

  def test_reuses_the_definition_already_in_the_model_instead_of_adding_a_hash_1_copy
    old = fittonia('3DW Fittonia (Sasha Alonso)', 'aaa')
    new = fittonia('3DW Fittonia (Sasha Alonso)#1', 'bbb')
    defs = Defs.new([old], new)
    defn, fresh = UMDBridge::Tools.load_definition(Model.new(defs), 'x.skp')
    assert_same old, defn
    refute fresh
    assert_equal [new], defs.removed
  end

  def test_same_component_id_is_reused_even_with_another_name
    old = fittonia('Fittonia in the lounge', 'same-guid')
    new = fittonia('3DW Fittonia (Sasha Alonso)', 'same-guid')
    defn, = UMDBridge::Tools.load_definition(Model.new(Defs.new([old], new)), 'x.skp')
    assert_same old, defn
  end

  def test_a_different_size_is_a_different_component
    old = fittonia('3DW Fittonia (Sasha Alonso)', 'aaa')
    new = Defn.new('3DW Fittonia (Sasha Alonso)#1', 'bbb', Box.new(inches(1.2), inches(1.1), inches(1.0)), [])
    defn, fresh = UMDBridge::Tools.load_definition(Model.new(Defs.new([old], new)), 'x.skp')
    assert_same new, defn
    assert fresh
  end

  def test_a_new_component_is_kept
    new = fittonia('3DW Money tree', 'ccc')
    defn, fresh = UMDBridge::Tools.load_definition(Model.new(Defs.new([], new)), 'x.skp')
    assert_same new, defn
    assert fresh
  end
end
