# UMD Bridge - units, bounds and finding entities.
# SketchUp stores lengths in INCHES internally. Everything that enters or leaves
# the bridge is in METRES. These helpers are the only place that converts.
module UMDBridge
  module Geo
    M_PER_IN = 0.0254

    module_function

    def m2i(m)
      m / M_PER_IN
    end

    def i2m(i)
      (i.to_f * M_PER_IN).round(6)
    end

    def pt(v)
      Geom::Point3d.new(m2i(v[0]), m2i(v[1]), m2i(v[2]))
    end

    def bounds_m(bb)
      return nil if bb.empty?
      {
        'min' => [i2m(bb.min.x), i2m(bb.min.y), i2m(bb.min.z)],
        'max' => [i2m(bb.max.x), i2m(bb.max.y), i2m(bb.max.z)]
      }
    end

    # World-space bounding box of a group/component, given its WORLD transformation.
    def world_bbox(entity, world_tr)
      bb = Geom::BoundingBox.new
      d = entity.definition.bounds
      (0..7).each { |i| bb.add(world_tr * d.corner(i)) }
      bb
    end

    def container?(e)
      e.is_a?(Sketchup::Group) || e.is_a?(Sketchup::ComponentInstance)
    end

    def label(e)
      n = e.name.to_s
      n.empty? ? e.definition.name : n
    end

    # Names from the top of the model down to this entity, or nil if a parent
    # is a component used more than once (then there is no single path).
    def path_of(entity)
      names = [label(entity)]
      parent = entity.parent
      while parent.is_a?(Sketchup::ComponentDefinition)
        instances = parent.instances
        return nil unless instances.length == 1
        inst = instances.first
        names.unshift(label(inst))
        parent = inst.parent
      end
      names
    end

    # True if any parent is a component used more than once.
    def inside_shared?(entity)
      parent = entity.parent
      while parent.is_a?(Sketchup::ComponentDefinition)
        return true if parent.instances.length > 1
        parent = parent.instances.first.parent
      end
      false
    end

    # bb: Geom::BoundingBox (inches); box: { 'min' => [m], 'max' => [m] }
    def overlaps?(bb, box)
      lo = [bb.min.x, bb.min.y, bb.min.z].map { |v| i2m(v) }
      hi = [bb.max.x, bb.max.y, bb.max.z].map { |v| i2m(v) }
      (0..2).all? { |i| lo[i] <= box['max'][i] && hi[i] >= box['min'][i] }
    end

    # Is the transformation stretched? Each axis column of an unscaled one has length 1.
    def scaled?(tr)
      a = tr.to_a
      [[0, 1, 2], [4, 5, 6], [8, 9, 10]].any? do |idx|
        len = Math.sqrt(idx.sum { |i| a[i] * a[i] })
        (len - 1.0).abs > 1e-6
      end
    end

    # Walks up from a nested entity to the model, multiplying transformations.
    # Returns nil if a parent is a component used more than once (no single answer).
    def world_transformation(entity)
      tr = entity.transformation
      parent = entity.parent
      while parent.is_a?(Sketchup::ComponentDefinition)
        instances = parent.instances
        return nil unless instances.length == 1
        inst = instances.first
        tr = inst.transformation * tr
        parent = inst.parent
      end
      tr
    end

    # target: { 'entityId' => n } | { 'persistentId' => n } | { 'path' => [...] }
    # Returns [entity, world_transformation].
    def resolve(model, target)
      key, value = target.first
      case key
      when 'entityId'
        e = model.find_entity_by_id(value)
        raise ToolError.new('NOT_FOUND', "no group/component with entityId #{value}") unless e && container?(e)
        tr = world_transformation(e)
        raise ToolError.new('INVALID_ARGS', "entity #{value} sits inside a component used more than once; target that component instead") unless tr
        [e, tr]
      when 'persistentId'
        e = model.find_entity_by_persistent_id(value)
        raise ToolError.new('NOT_FOUND', "no group/component with persistentId #{value}") unless e && container?(e)
        tr = world_transformation(e)
        raise ToolError.new('INVALID_ARGS', "entity #{value} sits inside a component used more than once; target that component instead") unless tr
        [e, tr]
      when 'path'
        resolve_path(model, value)
      end
    end

    def resolve_path(model, names)
      entities = model.entities
      tr = Geom::Transformation.new
      found = nil
      names.each do |n|
        matches = entities.select { |e| container?(e) && (e.name == n || e.definition.name == n) }
        if matches.empty?
          raise ToolError.new('NOT_FOUND', "path #{names.inspect}: nothing called \"#{n}\"")
        elsif matches.length > 1
          raise ToolError.new('INVALID_ARGS', "path #{names.inspect}: \"#{n}\" matches #{matches.length} things; use entityId",
                              { 'entityIds' => matches.map(&:entityID) })
        end
        found = matches.first
        tr = tr * found.transformation
        entities = found.definition.entities
      end
      [found, tr]
    end
  end
end
