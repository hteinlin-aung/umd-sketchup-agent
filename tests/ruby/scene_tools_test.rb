# Plain Ruby test of addScene with a fake SketchUp:   ruby tests/ruby/scene_tools_test.rb
# Covers the LOGIC: a taken name gets " (2)", your own view comes back, the camera is read back,
# hidden tags are reported. Whether D5 picks the scene up is tested on Windows.
require 'minitest/autorun'
require_relative 'fake_sketchup'
require 'tmpdir'

Z_AXIS = Geom::Vector3d.new(0, 0, 1) unless defined?(Z_AXIS)

class Sketchup::Camera
  attr_reader :eye, :target, :up, :fov
  def initialize(eye, target, up, perspective = true, fov = 30)
    @eye = eye
    @target = target
    @up = up
    @perspective = perspective
    @fov = fov.to_f
  end

  def perspective?; @perspective; end
end

class FakeView
  attr_accessor :camera, :model
  attr_reader :shadows_when_drawn
  def write_image(opts)
    @shadows_when_drawn = model.shadow_info['DisplayShadows']
    File.write(opts[:filename], 'png')
    true
  end
end

class FakePage
  attr_reader :name, :camera
  def initialize(name, camera); @name = name; @camera = camera; end
end

class FakePages
  include Enumerable
  def initialize(view, names); @view = view; @items = names.map { |n| FakePage.new(n, nil) }; end
  def each(&block); @items.each(&block); end
  def [](name); @items.find { |p| p.name == name }; end
  def count; @items.length; end
  def add(name); p = FakePage.new(name, @view.camera); @items << p; p; end # takes the view's camera, like SketchUp
end

class SceneModel < FakeModel
  attr_reader :pages, :active_view
  def initialize(path, scenes)
    super(path)
    @active_view = FakeView.new
    @active_view.model = self
    @shadow_info = { 'DisplayShadows' => false }
    @active_view.camera = Sketchup::Camera.new(Geom::Point3d.new(0, 0, 0), Geom::Point3d.new(1, 0, 0), Z_AXIS, true, 35)
    @pages = FakePages.new(@active_view, scenes)
    @layers = [FakeLayer.new('Layer0'), FakeLayer.new('1F Reception - Lighting (T128)', false)]
  end

  def layers; @layers; end
  attr_reader :shadow_info
end

# Windows, 2026-11-14: on the full MASTER copy, with shadows on, one check picture took 341 s instead of 7 s.
class CaptureViewShadowsTest < Minitest::Test
  def setup
    @model = SceneModel.new('E:/x/dev/UMD_DEV_FULL_copy.skp', [])
    Sketchup.active_model = @model
    @dir = Dir.mktmpdir
    Dir.mkdir(File.join(@dir, 'images'))
    @ctx = { warnings: [], queue_dir: @dir }
  end

  def capture(name)
    args = UMDBridge::Validate.captureView('fileName' => name, 'camera' => { 'eye' => [0, 0, 1.6], 'target' => [5, 0, 1.6] })
    UMDBridge::Tools.captureView(args, @ctx)
  end

  # Putting them back made SketchUp redraw the live view with shadows and froze it for ~2 minutes (Windows, 2026-11-14).
  def test_takes_the_picture_without_shadows_and_leaves_them_off_with_a_warning
    @model.shadow_info['DisplayShadows'] = true
    capture('a.png')
    assert_equal false, @model.active_view.shadows_when_drawn
    assert_equal false, @model.shadow_info['DisplayShadows']
    assert_match(/now OFF in the open model/, @ctx[:warnings].join)
  end

  def test_leaves_shadows_off_and_says_nothing_when_they_were_off
    capture('b.png')
    assert_equal false, @model.shadow_info['DisplayShadows']
    assert_empty @ctx[:warnings]
  end
end

class SceneToolsTest < Minitest::Test
  ARGS = { 'name' => 'Reception - from the entrance', 'eye' => [10.0, 5.6, 3.09], 'target' => [15.0, 10.0, 3.09], 'fov' => 55.0 }.freeze

  def setup
    @model = SceneModel.new('E:/x/dev/UMD_DEV_1F.skp', ['1F Reception'])
    Sketchup.active_model = @model
    @ctx = { warnings: [] }
  end

  def test_adds_a_scene_with_the_asked_camera
    data = UMDBridge::Tools.addScene(ARGS.dup, @ctx)
    assert_equal 'Reception - from the entrance', data['name']
    assert_equal false, data['renamed']
    assert_equal 2, data['sceneCount']
    assert_equal [10.0, 5.6, 3.09], data['eye']
    assert_equal [15.0, 10.0, 3.09], data['target']
    assert_equal 55.0, data['fov']
    assert_equal [], @ctx[:warnings]
  end

  def test_your_own_view_comes_back
    before = @model.active_view.camera
    UMDBridge::Tools.addScene(ARGS.dup, @ctx)
    after = @model.active_view.camera
    assert_equal [before.eye.x, before.target.x, before.fov], [after.eye.x, after.target.x, after.fov]
  end

  def test_never_changes_a_scene_you_have
    UMDBridge::Tools.addScene(ARGS.merge('name' => '1F Reception'), @ctx)
    data = UMDBridge::Tools.addScene(ARGS.merge('name' => '1F Reception'), @ctx)
    assert_equal '1F Reception (3)', data['name']
    assert_equal true, data['renamed']
    assert_nil @model.pages['1F Reception'].camera # the original was not touched
    assert_match(/already exists/, @ctx[:warnings].last)
  end

  def test_reports_the_tags_the_scene_keeps_hidden
    assert_equal ['1F Reception - Lighting (T128)'], UMDBridge::Tools.addScene(ARGS.dup, @ctx)['hiddenTags']
  end

  def test_validator_fills_the_field_of_view
    assert_equal 55.0, UMDBridge::Validate.addScene(ARGS.reject { |k, _| k == 'fov' })['fov']
  end

  def test_is_a_write_tool
    assert_equal :write, UMDBridge.tools['addScene']
  end
end
