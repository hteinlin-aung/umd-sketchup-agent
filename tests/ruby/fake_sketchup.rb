# Shared fake SketchUp for the plain-Ruby tests (no SketchUp needed).
# Only what the bridge touches is faked. Passing these tests does NOT prove real
# SketchUp geometry works - that is what `npm run smoke` on Windows is for.
require 'json'
require 'time'
require 'tmpdir'
require 'fileutils'

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


# ---------- a little geometry, for the Week 2 read tools ----------
module Geom
  class Transformation # always the identity in these tests
    def initialize(*_a); end
    def *(other); other.is_a?(Transformation) ? self : other; end
    def inverse; self; end
    def to_a; [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; end
  end

  class Point3d
    attr_reader :x, :y, :z
    def initialize(x, y, z); @x = x.to_f; @y = y.to_f; @z = z.to_f; end
    def distance(o); Math.sqrt((x - o.x)**2 + (y - o.y)**2 + (z - o.z)**2); end
    def offset(v, d); Point3d.new(x + v.x * d, y + v.y * d, z + v.z * d); end
  end

  class Vector3d
    attr_reader :x, :y, :z
    def initialize(x, y, z); @x = x.to_f; @y = y.to_f; @z = z.to_f; end
  end
end

class Sketchup::ComponentDefinition
  attr_reader :name, :entities, :instances
  def initialize(name, entities); @name = name; @entities = entities; @instances = []; end
  def count_instances; @instances.length; end
end

class Sketchup::Face
  attr_reader :layer, :material
  def initialize(tag = 'Layer0', material = nil)
    @layer = FakeNamed.new(tag)
    @material = material && FakeNamed.new(material)
  end
end

# A group/component with a definition, a tag and a fake world box (already in metres).
module FakeContainer
  attr_reader :name, :definition, :layer, :entityID, :persistent_id, :fake_bounds, :material
  attr_accessor :parent
  def setup(name, tag, bounds, children, defname)
    @name = name
    @layer = FakeNamed.new(tag)
    @fake_bounds = bounds
    @@ids = (defined?(@@ids) ? @@ids : 100) + 1
    @entityID = @@ids
    @persistent_id = @@ids * 7
    @definition = Sketchup::ComponentDefinition.new(defname || "Group##{@@ids}", children)
    @definition.instances << self
    children.each { |c| c.parent = @definition }
    self
  end
  def transformation; Geom::Transformation.new; end
  def hidden?; false; end
end

class FakeGroup < Sketchup::Group
  include FakeContainer
  def initialize(name, tag: 'Layer0', bounds: { 'min' => [0, 0, 0], 'max' => [1, 1, 1] }, children: [])
    setup(name, tag, bounds, children, nil)
  end
end

class FakeComponent < Sketchup::ComponentInstance
  include FakeContainer
  def initialize(defname, tag: 'Layer0', bounds: { 'min' => [0, 0, 0], 'max' => [1, 1, 1] }, children: [])
    setup('', tag, bounds, children, defname)
  end
  def share_definition_with(other)
    @definition = other.definition
    @definition.instances << self
    self
  end
end

def file_loaded?(*_a); false; end
def file_loaded(*_a); nil; end

load File.join(__dir__, '..', '..', 'sketchup', 'umd_bridge', 'main.rb')
