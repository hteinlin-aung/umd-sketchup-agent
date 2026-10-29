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

      jobs = model.entities.grep(Sketchup::Group).select { |g| g.name == args['jobGroup'] }
      raise ToolError.new('INVALID_ARGS', "#{jobs.length} top-level groups are called \"#{args['jobGroup']}\"") if jobs.length > 1
      job = jobs.first
      unless job
        job = model.entities.add_group
        job.name = args['jobGroup']
      end

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
