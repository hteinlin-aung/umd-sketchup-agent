# UMD Bridge - argument checks.
# Mirrors src/protocol/tools.ts. The TypeScript side already checks with Zod, but the
# bridge never trusts its sender. This file has NO SketchUp dependency, so it can be
# tested with plain Ruby: ruby tests/ruby/args_test.rb
module UMDBridge
  class ToolError < StandardError
    attr_reader :code, :details

    def initialize(code, message, details = nil)
      super(message)
      @code = code
      @details = details
    end
  end

  module Args
    MAX_COORD_M = 2000.0
    NAME_RANGE = (1..120).freeze

    module_function

    def invalid(key, message)
      ToolError.new('INVALID_ARGS', "#{key}: #{message}")
    end

    def only!(args, allowed)
      raise ToolError.new('INVALID_ARGS', 'args must be a JSON object') unless args.is_a?(Hash)
      extra = args.keys - allowed
      raise ToolError.new('INVALID_ARGS', "unknown argument(s): #{extra.join(', ')}") unless extra.empty?
    end

    def number?(v)
      (v.is_a?(Integer) || v.is_a?(Float)) && v.finite?
    end

    def name(args, key, required: true)
      v = args[key]
      return nil if v.nil? && !required
      raise invalid(key, 'is required') if v.nil?
      raise invalid(key, 'must be text') unless v.is_a?(String)
      v = v.strip
      raise invalid(key, 'must be 1-120 characters') unless NAME_RANGE.cover?(v.length)
      v
    end

    def vec3(args, key)
      v = args[key]
      unless v.is_a?(Array) && v.length == 3 && v.all? { |n| number?(n) }
        raise invalid(key, 'must be [x, y, z] numbers in metres')
      end
      raise invalid(key, "each value must be within +-#{MAX_COORD_M.to_i} m") unless v.all? { |n| n.abs <= MAX_COORD_M }
      v.map(&:to_f)
    end

    def int(args, key, min, max, default)
      v = args.key?(key) ? args[key] : default
      raise invalid(key, "must be a whole number #{min}-#{max}") unless v.is_a?(Integer) && v >= min && v <= max
      v
    end

    def enum(args, key, list, default)
      v = args.key?(key) ? args[key] : default
      raise invalid(key, "must be one of #{list.join(', ')}") unless list.include?(v)
      v
    end

    def bool(args, key, default)
      v = args.key?(key) ? args[key] : default
      raise invalid(key, 'must be true or false') unless v == true || v == false
      v
    end

    def rgb(args, key)
      v = args[key]
      return nil if v.nil?
      unless v.is_a?(Array) && v.length == 3 && v.all? { |n| n.is_a?(Integer) && n >= 0 && n <= 255 }
        raise invalid(key, 'must be [r, g, b] whole numbers 0-255')
      end
      v
    end

    def file_name(args, key, ext)
      v = args[key]
      unless v.is_a?(String) && v =~ /\A[A-Za-z0-9 _.\-]{1,100}\.#{ext}\z/ && !v.include?('..')
        raise invalid(key, "must be a plain file name ending in .#{ext} (no folders)")
      end
      v
    end

    # [[x, y], ...] footprint corners in metres
    def points2d(args, key, min, max)
      v = args[key]
      valid = v.is_a?(Array) && v.length >= min && v.length <= max &&
              v.all? { |p| p.is_a?(Array) && p.length == 2 && p.all? { |n| number?(n) && n.abs <= MAX_COORD_M } }
      raise invalid(key, "must be #{min}-#{max} [x, y] points in metres") unless valid
      v.map { |p| p.map(&:to_f) }
    end

    def coord(args, key)
      v = args[key]
      raise invalid(key, "must be a number within +-#{MAX_COORD_M.to_i} m") unless number?(v) && v.abs <= MAX_COORD_M
      v.to_f
    end

    # Shoelace formula, same as polygonArea() in tools.ts
    def polygon_area(points)
      twice = 0.0
      points.each_with_index do |(x1, y1), i|
        x2, y2 = points[(i + 1) % points.length]
        twice += x1 * y2 - x2 * y1
      end
      twice.abs / 2.0
    end

    # Same as edgesCross() in tools.ts: do any two non-neighbouring edges cross or touch?
    def edges_cross?(points)
      n = points.length
      orient = lambda do |a, b, c|
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        v.abs < 1e-12 ? 0 : (v <=> 0)
      end
      on_segment = lambda do |a, b, p|
        [a[0], b[0]].min <= p[0] && p[0] <= [a[0], b[0]].max && [a[1], b[1]].min <= p[1] && p[1] <= [a[1], b[1]].max
      end
      intersects = lambda do |p1, p2, q1, q2|
        o1 = orient.call(p1, p2, q1)
        o2 = orient.call(p1, p2, q2)
        o3 = orient.call(q1, q2, p1)
        o4 = orient.call(q1, q2, p2)
        return true if o1 != o2 && o3 != o4
        (o1.zero? && on_segment.call(p1, p2, q1)) || (o2.zero? && on_segment.call(p1, p2, q2)) ||
          (o3.zero? && on_segment.call(q1, q2, p1)) || (o4.zero? && on_segment.call(q1, q2, p2))
      end
      (0...n).each do |i|
        ((i + 2)...n).each do |j|
          next if i.zero? && j == n - 1
          return true if intersects.call(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])
        end
      end
      false
    end

    def bounds(args, key, required: true)
      b = args[key]
      return nil if b.nil? && !required
      raise invalid(key, 'must be { "min": [x,y,z], "max": [x,y,z] }') unless b.is_a?(Hash) && b.keys.sort == %w[max min]
      lo = vec3(b, 'min')
      hi = vec3(b, 'max')
      raise invalid(key, 'min must not be greater than max') unless (0..2).all? { |i| lo[i] <= hi[i] }
      { 'min' => lo, 'max' => hi }
    end

    # Exactly one of: { "entityId": n } | { "persistentId": n } | { "path": ["name", ...] }
    def target(args, key, required: true)
      t = args[key]
      return nil if t.nil? && !required
      raise invalid(key, 'is required') if t.nil?
      unless t.is_a?(Hash) && t.size == 1
        raise invalid(key, 'must have exactly one of entityId, persistentId, path')
      end
      k, v = t.first
      case k
      when 'entityId', 'persistentId'
        raise invalid(key, "#{k} must be a positive whole number") unless v.is_a?(Integer) && v > 0
      when 'path'
        valid = v.is_a?(Array) && (1..12).cover?(v.length) &&
                v.all? { |n| n.is_a?(String) && NAME_RANGE.cover?(n.strip.length) }
        raise invalid(key, 'path must be 1-12 names') unless valid
        t = { 'path' => v.map(&:strip) }
      else
        raise invalid(key, "unknown target type #{k}")
      end
      t
    end
  end

  # One validator per tool: checks, fills defaults, returns a clean Hash.
  module Validate
    module_function

    def ping(a)
      Args.only!(a, [])
      {}
    end

    def getModelInfo(a)
      Args.only!(a, %w[maxItems])
      { 'maxItems' => Args.int(a, 'maxItems', 1, 1000, 200) }
    end

    def createBox(a)
      Args.only!(a, %w[jobGroup name tag min max material])
      v = {
        'jobGroup' => Args.name(a, 'jobGroup'),
        'name' => Args.name(a, 'name'),
        'tag' => Args.name(a, 'tag'),
        'min' => Args.vec3(a, 'min'),
        'max' => Args.vec3(a, 'max'),
        'material' => Args.name(a, 'material', required: false)
      }
      (0..2).each do |i|
        raise Args.invalid('max', 'max must be greater than min on x, y and z') unless v['max'][i] > v['min'][i]
        raise Args.invalid('max', 'every side must be at least 1 mm') if v['max'][i] - v['min'][i] < 0.001
      end
      v
    end

    def applyMaterial(a)
      Args.only!(a, %w[target material color faces paintBack])
      {
        'target' => Args.target(a, 'target'),
        'material' => Args.name(a, 'material'),
        'color' => Args.rgb(a, 'color'),
        'faces' => Args.enum(a, 'faces', %w[all top sides], 'all'),
        'paintBack' => Args.bool(a, 'paintBack', false)
      }
    end

    def captureView(a)
      Args.only!(a, %w[fileName width height scene zoomTo])
      {
        'fileName' => Args.file_name(a, 'fileName', 'png'),
        'width' => Args.int(a, 'width', 320, 4096, 1600),
        'height' => Args.int(a, 'height', 240, 4096, 900),
        'scene' => Args.name(a, 'scene', required: false),
        'zoomTo' => Args.target(a, 'zoomTo', required: false)
      }
    end

    def findEntities(a)
      Args.only!(a, %w[within name tag type touches maxDepth limit])
      name = a['name']
      unless name.nil? || (name.is_a?(String) && Args::NAME_RANGE.cover?(name.strip.length))
        raise Args.invalid('name', 'must be 1-120 characters')
      end
      {
        'within' => Args.target(a, 'within', required: false),
        'name' => name && name.strip,
        'tag' => Args.name(a, 'tag', required: false),
        'type' => Args.enum(a, 'type', %w[any Group ComponentInstance], 'any'),
        'touches' => Args.bounds(a, 'touches', required: false),
        'maxDepth' => Args.int(a, 'maxDepth', 1, 8, 3),
        'limit' => Args.int(a, 'limit', 1, 500, 100)
      }
    end

    def inspectEntity(a)
      Args.only!(a, %w[target maxChildren])
      { 'target' => Args.target(a, 'target'), 'maxChildren' => Args.int(a, 'maxChildren', 0, 200, 50) }
    end

    DIRECTIONS = {
      'down' => [0, 0, -1], 'up' => [0, 0, 1], 'north' => [0, 1, 0],
      'south' => [0, -1, 0], 'east' => [1, 0, 0], 'west' => [-1, 0, 0]
    }.freeze

    def measure(a)
      Args.only!(a, %w[from direction maxDistance allHits maxHits])
      d = a.key?('maxDistance') ? a['maxDistance'] : 50
      raise Args.invalid('maxDistance', 'must be a number 0.01-500 (metres)') unless Args.number?(d) && d >= 0.01 && d <= 500
      {
        'from' => Args.vec3(a, 'from'),
        'direction' => Args.enum(a, 'direction', DIRECTIONS.keys, 'down'),
        'maxDistance' => d.to_f,
        'allHits' => Args.bool(a, 'allHits', false),
        'maxHits' => Args.int(a, 'maxHits', 1, 50, 20)
      }
    end

    def createPrism(a)
      Args.only!(a, %w[jobGroup name tag points z0 z1 material])
      v = {
        'jobGroup' => Args.name(a, 'jobGroup'),
        'name' => Args.name(a, 'name'),
        'tag' => Args.name(a, 'tag'),
        'points' => Args.points2d(a, 'points', 3, 200),
        'z0' => Args.coord(a, 'z0'),
        'z1' => Args.coord(a, 'z1'),
        'material' => Args.name(a, 'material', required: false)
      }
      raise Args.invalid('z1', 'z1 must be at least 1 mm above z0') unless v['z1'] - v['z0'] >= 0.001
      pts = v['points']
      pts.each_with_index do |p, i|
        q = pts[(i + 1) % pts.length]
        if Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.001
          raise Args.invalid('points', 'two neighbouring points are less than 1 mm apart (repeated point?)')
        end
      end
      raise Args.invalid('points', 'the footprint has (almost) no area') if Args.polygon_area(pts) < 0.0001
      raise Args.invalid('points', "the footprint's edges cross each other (a 'bow tie' shape)") if Args.edges_cross?(pts)
      v
    end

    def setTag(a)
      Args.only!(a, %w[target tag])
      { 'target' => Args.target(a, 'target'), 'tag' => Args.name(a, 'tag') }
    end

    def setTagVisibility(a)
      Args.only!(a, %w[tag visible])
      raise Args.invalid('visible', 'is required (true or false)') unless a.key?('visible')
      { 'tag' => Args.name(a, 'tag'), 'visible' => Args.bool(a, 'visible', nil) }
    end

    def moveToReplaced(a)
      Args.only!(a, %w[target replacedBy])
      by = a['replacedBy']
      raise Args.invalid('replacedBy', 'must be 1-60 characters') unless by.is_a?(String) && (1..60).cover?(by.strip.length)
      { 'target' => Args.target(a, 'target'), 'replacedBy' => by.strip }
    end

    def saveCopy(a)
      Args.only!(a, %w[fileName])
      f = Args.file_name(a, 'fileName', 'skp')
      raise Args.invalid('fileName', 'a copy must not be called MASTER') if f =~ /master/i
      { 'fileName' => f }
    end
  end
end
