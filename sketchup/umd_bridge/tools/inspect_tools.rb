# UMD Bridge - Week 2 read-only tools: findEntities, inspectEntity, measure.
# They never change the model, so main.rb allows them on any open model (even the MASTER).
module UMDBridge
  module Tools
    # A full walk of the 600 MB master can visit tens of thousands of groups and
    # freeze SketchUp for a long time. Past this, stop and say so (scanLimitHit).
    SCAN_LIMIT = 30_000
    SQ_M_PER_SQ_IN = 0.0254 * 0.0254

    module_function

    def findEntities(args, _ctx)
      model = Sketchup.active_model
      if args['within']
        start, start_tr = Geo.resolve(model, args['within'])
        entities = start.definition.entities
        base_path = Geo.path_of(start) || [Geo.label(start)]
        base_shared = Geo.inside_shared?(start) || shared_component?(start)
      else
        entities = model.entities
        start_tr = Geom::Transformation.new
        base_path = []
        base_shared = false
      end

      want_name = args['name'] && args['name'].downcase
      want_tag = args['tag'] && args['tag'].downcase
      state = { matches: [], scanned: 0, truncated: false, limit_hit: false }
      walk = lambda do |ents, tr, path, depth, shared|
        ents.each do |e|
          next unless Geo.container?(e)
          if state[:scanned] >= SCAN_LIMIT
            state[:limit_hit] = true
            return
          end
          state[:scanned] += 1
          wt = tr * e.transformation
          here = path + [Geo.label(e)]
          bb = nil
          hit = (want_name.nil? || e.name.to_s.downcase.include?(want_name) || e.definition.name.to_s.downcase.include?(want_name)) &&
                (want_tag.nil? || e.layer.name.downcase == want_tag) &&
                type_matches?(e, args['type'])
          if hit && args['touches']
            bb = Geo.world_bbox(e, wt)
            hit = Geo.overlaps?(bb, args['touches'])
          end
          if hit
            if state[:matches].length < args['limit']
              bb ||= Geo.world_bbox(e, wt)
              state[:matches] << found(e, bb, here, depth, shared)
            else
              state[:truncated] = true
              return
            end
          end
          if depth < args['maxDepth']
            walk.call(e.definition.entities, wt, here, depth + 1, shared || shared_component?(e))
            return if state[:truncated] || state[:limit_hit]
          end
        end
      end
      walk.call(entities, start_tr, base_path, 1, base_shared)

      {
        'matches' => state[:matches],
        'truncated' => state[:truncated],
        'scanned' => state[:scanned],
        'scanLimitHit' => state[:limit_hit]
      }
    end

    def type_matches?(e, type)
      return true if type == 'any'
      type == 'Group' ? e.is_a?(Sketchup::Group) : e.is_a?(Sketchup::ComponentInstance)
    end

    def shared_component?(e)
      e.is_a?(Sketchup::ComponentInstance) && e.definition.count_instances > 1
    end

    def found(e, bb, path, depth, inside_shared)
      {
        'entityId' => e.entityID,
        'persistentId' => e.persistent_id,
        'type' => e.is_a?(Sketchup::Group) ? 'Group' : 'ComponentInstance',
        'name' => e.name.to_s,
        'definitionName' => e.definition.name.to_s,
        'tag' => e.layer.name,
        'hidden' => e.hidden? ? true : false,
        'path' => path,
        'depth' => depth,
        'bounds' => Geo.bounds_m(bb) || { 'min' => [0, 0, 0], 'max' => [0, 0, 0] },
        'instanceCount' => e.definition.count_instances,
        'childCount' => e.definition.entities.count { |c| Geo.container?(c) },
        'insideSharedComponent' => inside_shared ? true : false
      }
    end

    def inspectEntity(args, ctx)
      model = Sketchup.active_model
      e, world_tr = Geo.resolve(model, args['target'])
      bb = Geo.world_bbox(e, world_tr)
      bm = Geo.bounds_m(bb) || { 'min' => [0, 0, 0], 'max' => [0, 0, 0] }
      scaled = Geo.scaled?(world_tr)
      ctx[:warnings] << 'this instance is scaled; areaM2 is measured on the unscaled definition' if scaled

      counts = { 'count' => 0, 'top' => 0, 'bottom' => 0, 'sides' => 0, 'other' => 0 }
      area = 0.0
      by_material = Hash.new(0)
      e.definition.entities.grep(Sketchup::Face).each do |f|
        counts['count'] += 1
        n = f.normal.transform(world_tr)
        n.normalize!
        side = if n.z > 0.99 then 'top' elsif n.z < -0.99 then 'bottom' elsif n.z.abs < 0.01 then 'sides' else 'other' end
        counts[side] += 1
        area += f.area
        by_material[f.material ? f.material.name : '(default)'] += 1
      end

      kids = e.definition.entities.select { |c| Geo.container?(c) }
      {
        'entityId' => e.entityID,
        'persistentId' => e.persistent_id,
        'type' => e.is_a?(Sketchup::Group) ? 'Group' : 'ComponentInstance',
        'name' => e.name.to_s,
        'definitionName' => e.definition.name.to_s,
        'tag' => e.layer.name,
        'hidden' => e.hidden? ? true : false,
        'path' => Geo.path_of(e),
        'worldBounds' => bm,
        'size' => (0..2).map { |i| (bm['max'][i] - bm['min'][i]).round(6) },
        'scaled' => scaled,
        'instanceCount' => e.definition.count_instances,
        'instanceMaterial' => e.material ? e.material.name : nil,
        'faces' => counts.merge('areaM2' => (area * SQ_M_PER_SQ_IN).round(4)),
        'materials' => by_material.map { |name, n| { 'name' => name, 'faces' => n } }.sort_by { |m| -m['faces'] },
        'childCount' => kids.length,
        'children' => kids.first(args['maxChildren']).map do |c|
          {
            'entityId' => c.entityID, 'persistentId' => c.persistent_id,
            'type' => c.is_a?(Sketchup::Group) ? 'Group' : 'ComponentInstance',
            'name' => c.name.to_s, 'definitionName' => c.definition.name.to_s, 'tag' => c.layer.name
          }
        end,
        'childrenTruncated' => kids.length > args['maxChildren']
      }
    end

    # Shoots a ray and lists the surfaces it hits (hidden geometry is ignored, as on screen).
    def measure(args, _ctx)
      model = Sketchup.active_model
      vec = Geom::Vector3d.new(*Validate::DIRECTIONS[args['direction']])
      origin = Geo.pt(args['from'])
      max_in = Geo.m2i(args['maxDistance'])
      step_in = Geo.m2i(0.001) # continue 1 mm past each hit so the next search can't hit the same face
      wanted = args['allHits'] ? args['maxHits'] : 1
      hits = []
      stopped = 'noMoreHits'
      start = origin
      loop do
        result = model.raytest([start, vec], true) # true = ignore hidden geometry
        break unless result
        point, path = result
        distance = origin.distance(point)
        if distance > max_in
          stopped = 'maxDistance'
          break
        end
        containers = path.select { |x| Geo.container?(x) }
        face = path.reverse.find { |x| x.is_a?(Sketchup::Face) }
        hits << {
          'point' => [Geo.i2m(point.x), Geo.i2m(point.y), Geo.i2m(point.z)],
          'distance' => Geo.i2m(distance),
          'path' => containers.map { |c| Geo.label(c) },
          'entityIds' => containers.map(&:entityID),
          'tag' => (containers.last || face || path.last).layer.name,
          'material' => face && face.material ? face.material.name : nil
        }
        if hits.length >= wanted
          stopped = 'maxHits'
          break
        end
        start = point.offset(vec, step_in)
      end
      { 'from' => args['from'], 'direction' => args['direction'], 'hits' => hits, 'stoppedBecause' => stopped }
    end
  end
end
