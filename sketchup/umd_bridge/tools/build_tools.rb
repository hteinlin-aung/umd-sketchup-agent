# UMD Bridge - tools that CHANGE geometry or materials.
# main.rb wraps each call in start_operation/commit_operation (one undo step)
# and aborts the whole operation if anything here raises.
module UMDBridge
  module Tools
    TOLERANCE_M = 0.001

    module_function

    def tag_named(model, name)
      model.layers[name] || model.layers.add(name)
    end

    def createBox(args, _ctx)
      model = Sketchup.active_model
      material = nil
      if args['material']
        material = model.materials[args['material']]
        raise ToolError.new('NOT_FOUND', "material \"#{args['material']}\" does not exist") unless material
      end

      job = job_group(model, args['jobGroup'])

      # Coordinates are WORLD coordinates; convert into the job group's own space.
      to_local = job.transformation.inverse
      x0, y0, z0 = args['min']
      x1, y1, z1 = args['max']
      corners = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]].map { |c| to_local * Geo.pt(c) }

      box = job.entities.add_group
      box.name = args['name']
      box.layer = tag_named(model, args['tag'])
      face = box.entities.add_face(corners)
      raise ToolError.new('TOOL_ERROR', 'SketchUp could not make the base face') unless face
      face.reverse! if face.normal.z < 0
      face.pushpull(Geo.m2i(z1 - z0))
      box.entities.grep(Sketchup::Face).each { |f| f.material = material } if material

      # Verify by MEASURING what was built, not by trusting the request.
      measured = Geo.bounds_m(Geo.world_bbox(box, job.transformation * box.transformation))
      wanted = { 'min' => args['min'], 'max' => args['max'] }
      err = %w[min max].flat_map { |k| (0..2).map { |i| (measured[k][i] - wanted[k][i]).abs } }.max
      faces = box.entities.grep(Sketchup::Face).length
      if err > TOLERANCE_M || faces != 6
        raise ToolError.new('VERIFY_FAILED', "box measured #{measured.inspect} with #{faces} faces (max error #{(err * 1000).round(3)} mm)")
      end

      {
        'entityId' => box.entityID,
        'persistentId' => box.persistent_id,
        'jobGroupId' => job.entityID,
        'worldBounds' => measured,
        'faceCount' => faces
      }
    end

    def job_group(model, name)
      jobs = model.entities.grep(Sketchup::Group).select { |g| g.name == name }
      raise ToolError.new('INVALID_ARGS', "#{jobs.length} top-level groups are called \"#{name}\"") if jobs.length > 1
      return jobs.first if jobs.first
      job = model.entities.add_group
      job.name = name
      job
    end

    CUBIC_M_PER_CUBIC_IN = 0.0254**3

    # A vertical prism: a footprint polygon (world x,y in metres) extruded from z0 to z1.
    # Partitions, built-in benches, wall panels, platforms...
    def createPrism(args, _ctx)
      model = Sketchup.active_model
      material = nil
      if args['material']
        material = model.materials[args['material']]
        raise ToolError.new('NOT_FOUND', "material \"#{args['material']}\" does not exist") unless material
      end
      job = job_group(model, args['jobGroup'])
      to_local = job.transformation.inverse
      corners = args['points'].map { |x, y| to_local * Geo.pt([x, y, args['z0']]) }

      prism = job.entities.add_group
      prism.name = args['name']
      prism.layer = tag_named(model, args['tag'])
      face = prism.entities.add_face(corners)
      raise ToolError.new('INVALID_ARGS', 'SketchUp could not make a face from these points (do the edges cross?)') unless face
      face.reverse! if face.normal.z < 0
      face.pushpull(Geo.m2i(args['z1'] - args['z0']))
      prism.entities.grep(Sketchup::Face).each { |f| f.material = material } if material

      # Verify by measuring: the box around it, and SketchUp's own solid volume.
      measured = Geo.bounds_m(Geo.world_bbox(prism, job.transformation * prism.transformation))
      xs = args['points'].map(&:first)
      ys = args['points'].map(&:last)
      wanted = { 'min' => [xs.min, ys.min, args['z0']], 'max' => [xs.max, ys.max, args['z1']] }
      err = %w[min max].flat_map { |k| (0..2).map { |i| (measured[k][i] - wanted[k][i]).abs } }.max
      area = Args.polygon_area(args['points'])
      expected_volume = area * (args['z1'] - args['z0'])
      volume = prism.volume * CUBIC_M_PER_CUBIC_IN
      if err > TOLERANCE_M
        raise ToolError.new('VERIFY_FAILED', "prism measured #{measured.inspect} (max error #{(err * 1000).round(3)} mm)")
      end
      if volume <= 0 || (volume - expected_volume).abs > [expected_volume * 0.001, 1e-6].max
        raise ToolError.new('VERIFY_FAILED',
                            "prism is not the expected solid: volume #{volume.round(6)} m3, expected #{expected_volume.round(6)} m3 " \
                            '(a footprint whose edges cross makes a broken shape)')
      end

      {
        'entityId' => prism.entityID,
        'persistentId' => prism.persistent_id,
        'jobGroupId' => job.entityID,
        'worldBounds' => measured,
        'footprintAreaM2' => area.round(6),
        'volumeM3' => volume.round(6),
        'faceCount' => prism.entities.grep(Sketchup::Face).length
      }
    end

    def setTag(args, _ctx)
      model = Sketchup.active_model
      entity, = Geo.resolve(model, args['target'])
      previous = entity.layer.name
      created = model.layers[args['tag']].nil?
      entity.layer = tag_named(model, args['tag'])
      raise ToolError.new('VERIFY_FAILED', "tag is #{entity.layer.name}") unless entity.layer.name == args['tag']
      { 'entityId' => entity.entityID, 'persistentId' => entity.persistent_id,
        'previousTag' => previous, 'tag' => entity.layer.name, 'created' => created }
    end

    def setTagVisibility(args, _ctx)
      model = Sketchup.active_model
      layer = model.layers[args['tag']]
      raise ToolError.new('NOT_FOUND', "tag \"#{args['tag']}\" does not exist") unless layer
      if layer == model.layers[0] && !args['visible']
        raise ToolError.new('INVALID_ARGS', "Untagged (#{layer.name}) can't be hidden")
      end
      previous = layer.visible? ? true : false
      layer.visible = args['visible']
      raise ToolError.new('VERIFY_FAILED', 'visibility did not change') unless layer.visible? == args['visible']
      { 'tag' => layer.name, 'previous' => previous, 'visible' => args['visible'] }
    end

    # Never deletes: puts the entity on a hidden "zz_REPLACED by ..." tag (your thesis convention).
    def moveToReplaced(args, _ctx)
      model = Sketchup.active_model
      entity, = Geo.resolve(model, args['target'])
      previous = entity.layer.name
      name = "zz_REPLACED by #{args['replacedBy']} (hidden)"
      layer = tag_named(model, name)
      layer.visible = false
      entity.layer = layer
      raise ToolError.new('VERIFY_FAILED', 'entity is not on the replaced tag') unless entity.layer == layer && !layer.visible?
      { 'entityId' => entity.entityID, 'persistentId' => entity.persistent_id,
        'previousTag' => previous, 'tag' => name, 'tagHidden' => true }
    end

    def applyMaterial(args, ctx)
      model = Sketchup.active_model
      entity, world_tr = Geo.resolve(model, args['target'])

      if entity.is_a?(Sketchup::ComponentInstance) && entity.definition.count_instances > 1
        raise ToolError.new('SHARED_DEFINITION',
                            "\"#{entity.definition.name}\" is used #{entity.definition.count_instances} times; " \
                            'painting it would change every copy')
      end
      if entity.is_a?(Sketchup::Group) && entity.definition.count_instances > 1
        entity.make_unique
        ctx[:warnings] << "group \"#{Geo.label(entity)}\" was a copy; made it unique before painting"
      end

      created = false
      material = model.materials[args['material']]
      unless material
        unless args['color']
          raise ToolError.new('NOT_FOUND', "material \"#{args['material']}\" does not exist (give \"color\" to create it)")
        end
        material = model.materials.add(args['material'])
        material.color = Sketchup::Color.new(*args['color'])
        created = true
      end

      all_faces = entity.definition.entities.grep(Sketchup::Face)
      faces = all_faces.select { |f| face_matches?(f, world_tr, args['faces']) }
      faces.each do |f|
        f.material = material
        f.back_material = material if args['paintBack']
      end
      if all_faces.empty?
        ctx[:warnings] << "\"#{Geo.label(entity)}\" has no faces directly inside it (its geometry is in nested groups)"
      end

      {
        'materialName' => material.name,
        'created' => created,
        'facesPainted' => faces.length,
        'facesChecked' => faces.count { |f| f.material == material }
      }
    end

    def face_matches?(face, world_tr, which)
      return true if which == 'all'
      n = face.normal.transform(world_tr)
      n.normalize!
      which == 'top' ? n.z > 0.99 : n.z.abs < 0.01
    end
  end
end
