# Plain Ruby test of the Week 2 read tools with a fake SketchUp:   ruby tests/ruby/read_tools_test.rb
# Covers the LOGIC of findEntities (walking, filters, limits, shared components) and
# measure (stepping through hits, distances, stop reasons). Real geometry: Windows.
require 'minitest/autorun'
require_relative 'fake_sketchup'

# World boxes in these fakes are already in metres, so make the bridge use them as-is.
module UMDBridge
  module Geo
    def self.world_bbox(entity, _tr); entity.fake_bounds; end
    def self.bounds_m(bb); bb; end
    def self.overlaps?(bb, box); (0..2).all? { |i| bb['min'][i] <= box['max'][i] && bb['max'][i] >= box['min'][i] }; end
  end
end

class TreeModel < FakeModel
  attr_reader :entities
  attr_accessor :planes
  def initialize(path, top)
    super(path)
    @entities = top
    top.each { |e| e.parent = self }
    @planes = []
  end

  def find_entity_by_id(id)
    stack = @entities.dup
    until stack.empty?
      e = stack.shift
      return e if e.entityID == id
      stack.concat(e.definition.entities)
    end
    nil
  end

  # Fake raytest: horizontal planes at given heights (inches), hit when shooting down.
  def raytest(ray, _wysiwyg)
    start, _vec = ray
    plane = @planes.select { |p| p[:z] < start.z }.max_by { |p| p[:z] }
    return nil unless plane
    [Geom::Point3d.new(start.x, start.y, plane[:z]), plane[:path]]
  end
end

class ReadToolsTest < Minitest::Test
  M = 0.0254

  def setup
    @bench = FakeGroup.new('Reception bench - light oak', tag: '1F Reception - Furniture (T128)',
                                                          bounds: { 'min' => [11, 6, 1.49], 'max' => [14, 6.5, 1.94] })
    @ceiling = FakeGroup.new('Reception ceiling', tag: 'Ceilings', bounds: { 'min' => [10, 5, 4.6], 'max' => [20, 15, 4.7] })
    @reception = FakeGroup.new('1F RECEPTION (T128)', tag: '1F Shell', bounds: { 'min' => [10, 5, 1.49], 'max' => [20, 15, 4.7] },
                                                      children: [@bench, @ceiling])
    @col_a = FakeComponent.new('UMD Column D500 1F', tag: 'Columns', bounds: { 'min' => [0, 0, 1.49], 'max' => [0.5, 0.5, 5] },
                                                     children: [FakeGroup.new('column core')])
    @col_b = FakeComponent.new('x', tag: 'Columns').share_definition_with(@col_a)
    @floor = FakeGroup.new('UMD 1F', tag: '1F Shell', bounds: { 'min' => [-73, -14, -1.01], 'max' => [38, 27, 14] },
                                     children: [@reception, @col_a, @col_b])
    @model = TreeModel.new('E:/x/dev/UMD_DEV_1F.skp', [@floor])
    Sketchup.active_model = @model
  end

  def find(args)
    UMDBridge::Tools.findEntities(UMDBridge::Validate.findEntities(args), { warnings: [] })
  end

  def test_name_search_is_case_insensitive_and_reports_the_path
    r = find('name' => 'BENCH')
    assert_equal 1, r['matches'].length
    m = r['matches'].first
    assert_equal ['UMD 1F', '1F RECEPTION (T128)', 'Reception bench - light oak'], m['path']
    assert_equal 3, m['depth']
    assert_equal @bench.entityID, m['entityId']
  end

  def test_name_also_matches_the_definition_name
    assert_equal 2, find('name' => 'column d500')['matches'].length
  end

  def test_max_depth_limits_how_deep_it_looks
    assert_equal ['UMD 1F'], find('maxDepth' => 1)['matches'].map { |m| m['name'] }
    refute(find('maxDepth' => 2)['matches'].any? { |m| m['name'].include?('bench') })
  end

  def test_tag_and_type_filters
    assert_equal ['Reception ceiling'], find('tag' => 'ceilings')['matches'].map { |m| m['name'] }
    assert_equal 2, find('type' => 'ComponentInstance')['matches'].length
  end

  def test_limit_sets_truncated
    r = find('limit' => 2)
    assert_equal 2, r['matches'].length
    assert r['truncated']
  end

  def test_things_inside_a_shared_component_are_flagged
    core = find('name' => 'column core', 'maxDepth' => 4)['matches']
    refute_empty core
    assert(core.all? { |m| m['insideSharedComponent'] })
    assert_equal 2, find('name' => 'column d500')['matches'].first['instanceCount']
  end

  def test_touches_keeps_only_overlapping_boxes
    r = find('touches' => { 'min' => [12, 6, 1.5], 'max' => [12.5, 6.2, 1.6] })
    names = r['matches'].map { |m| m['name'] }
    assert_includes names, 'Reception bench - light oak'
    refute_includes names, 'Reception ceiling'
  end

  def test_within_searches_inside_one_group
    r = find('within' => { 'path' => ['UMD 1F', '1F RECEPTION (T128)'] })
    assert_equal ['Reception bench - light oak', 'Reception ceiling'], r['matches'].map { |m| m['name'] }
    assert_equal ['UMD 1F', '1F RECEPTION (T128)', 'Reception ceiling'], r['matches'].last['path']
  end

  def test_measure_lists_every_surface_downwards_with_distances
    @model.planes = [
      { z: 4.7 / M, path: [@floor, @reception, @ceiling, Sketchup::Face.new('Layer0', 'White plaster')] },
      { z: 1.49 / M, path: [@floor] },
      { z: -1.01 / M, path: [@floor] }
    ]
    args = UMDBridge::Validate.measure('from' => [12, 7, 10], 'allHits' => true)
    r = UMDBridge::Tools.measure(args, {})
    assert_equal [4.7, 1.49, -1.01], r['hits'].map { |h| h['point'][2].round(3) }
    assert_equal [5.3, 8.51, 11.01], r['hits'].map { |h| h['distance'].round(3) }
    assert_equal ['UMD 1F', '1F RECEPTION (T128)', 'Reception ceiling'], r['hits'].first['path']
    assert_equal 'Ceilings', r['hits'].first['tag']
    assert_equal 'White plaster', r['hits'].first['material']
    assert_equal 'noMoreHits', r['stoppedBecause']
  end

  def test_measure_first_hit_only_by_default
    @model.planes = [{ z: 1.49 / M, path: [@floor] }, { z: -1.01 / M, path: [@floor] }]
    r = UMDBridge::Tools.measure(UMDBridge::Validate.measure('from' => [0, 0, 10]), {})
    assert_equal 1, r['hits'].length
    assert_equal 'maxHits', r['stoppedBecause']
  end

  def test_measure_respects_max_distance_and_max_hits
    @model.planes = [{ z: 1.49 / M, path: [@floor] }, { z: -1.01 / M, path: [@floor] }]
    far = UMDBridge::Tools.measure(UMDBridge::Validate.measure('from' => [0, 0, 10], 'allHits' => true, 'maxDistance' => 9), {})
    assert_equal 1, far['hits'].length
    assert_equal 'maxDistance', far['stoppedBecause']
    few = UMDBridge::Tools.measure(UMDBridge::Validate.measure('from' => [0, 0, 10], 'allHits' => true, 'maxHits' => 1), {})
    assert_equal 'maxHits', few['stoppedBecause']
  end
end
