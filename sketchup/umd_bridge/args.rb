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

    def saveCopy(a)
      Args.only!(a, %w[fileName])
      f = Args.file_name(a, 'fileName', 'skp')
      raise Args.invalid('fileName', 'a copy must not be called MASTER') if f =~ /master/i
      { 'fileName' => f }
    end
  end
end
