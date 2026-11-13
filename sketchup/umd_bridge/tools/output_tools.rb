# UMD Bridge - tools that write FILES (screenshots, saved copies).
module UMDBridge
  module Tools
    module_function

    def captureView(args, ctx)
      model = Sketchup.active_model
      view = model.active_view
      path = File.join(ctx[:queue_dir], 'images', args['fileName'])
      raise ToolError.new('FILE_EXISTS', "#{path} already exists; choose a new name") if File.exist?(path)

      c = view.camera
      saved = Sketchup::Camera.new(c.eye, c.target, c.up, c.perspective?, c.fov)
      # A check picture, not a render (D5 renders): no shadows. With shadows on, SketchUp works them out for the
      # whole model, floors above included - on the full MASTER copy one picture took 341 s instead of 11 s
      # (Windows, 2026-11-14). They are NOT switched back on: that makes SketchUp redraw the live view with shadows,
      # which froze it for about 2 minutes and cancelled the next command. Only the open dev model and its saved
      # copy are affected (the MASTER is never opened for changes); scenes keep their own shadow settings.
      shadows = model.shadow_info
      if shadows['DisplayShadows']
        shadows['DisplayShadows'] = false
        ctx[:warnings] << 'shadows were on and are now OFF in the open model (too slow to draw on a big model); ' \
                          'turn them on again in Window > Shadows if you need them'
      end
      begin
        if args['scene']
          page = model.pages[args['scene']]
          raise ToolError.new('NOT_FOUND', "scene \"#{args['scene']}\" does not exist") unless page
          view.camera = page.camera
          ctx[:warnings] << "used the camera of scene \"#{args['scene']}\" only (its tag visibility is not applied yet)"
        end
        if args['zoomTo']
          entity, world_tr = Geo.resolve(model, args['zoomTo'])
          view.camera = iso_camera(Geo.world_bbox(entity, world_tr))
        end
        if args['camera']
          # The agent's eye-level view of new pieces: stand exactly here for this one picture, then put the camera
          # back. Unlike addScene, nothing is added to the model.
          c = args['camera']
          view.camera = Sketchup::Camera.new(Geo.pt(c['eye']), Geo.pt(c['target']), Z_AXIS, true, c['fov'])
        end
        ok = view.write_image(filename: path, width: args['width'], height: args['height'], antialias: true, transparent: false)
        raise ToolError.new('VERIFY_FAILED', "write_image failed for #{path}") unless ok && File.exist?(path) && File.size(path) > 0
      ensure
        view.camera = saved
      end

      { 'path' => path, 'bytes' => File.size(path), 'width' => args['width'], 'height' => args['height'] }
    end

    # A camera looking at a bounding box from the south-east, slightly above.
    def iso_camera(bb)
      center = bb.center
      fov = 35.0
      radius = [bb.diagonal / 2.0, 1.0].max
      distance = radius / Math.tan((fov / 2.0) * Math::PI / 180.0) * 1.15
      dir = Geom::Vector3d.new(1, -1, 0.8)
      dir.normalize!
      eye = center.offset(dir, distance)
      Sketchup::Camera.new(eye, center, Z_AXIS, true, fov)
    end

    # A saved camera view (scene). It remembers the camera and which tags are visible right now, which
    # is what D5 Render picks up. An existing scene is never changed: a taken name gets " (2)", " (3)" ...
    def addScene(args, ctx)
      model = Sketchup.active_model
      pages = model.pages
      name = free_scene_name(pages, args['name'])
      ctx[:warnings] << "a scene called \"#{args['name']}\" already exists, so this one is \"#{name}\"" if name != args['name']

      view = model.active_view
      c = view.camera
      saved = Sketchup::Camera.new(c.eye, c.target, c.up, c.perspective?, c.fov)
      begin
        view.camera = Sketchup::Camera.new(Geo.pt(args['eye']), Geo.pt(args['target']), Z_AXIS, true, args['fov'])
        page = pages.add(name) # takes the camera and tag visibility of the view as it is now
      ensure
        view.camera = saved # your own view comes back; the scene keeps its own camera
      end
      raise ToolError.new('VERIFY_FAILED', "the scene \"#{name}\" was not added") unless page && pages[name]

      cam = page.camera
      eye = [cam.eye.x, cam.eye.y, cam.eye.z].map { |v| Geo.i2m(v) }
      target = [cam.target.x, cam.target.y, cam.target.z].map { |v| Geo.i2m(v) }
      off = (0..2).map { |i| (eye[i] - args['eye'][i]).abs }.max
      raise ToolError.new('VERIFY_FAILED', "the scene's camera is #{off.round(3)} m away from where it was asked") if off > 0.001

      { 'name' => name, 'renamed' => name != args['name'], 'sceneCount' => pages.count,
        'eye' => eye.map { |v| v.round(4) }, 'target' => target.map { |v| v.round(4) }, 'fov' => cam.fov.round(2),
        'hiddenTags' => model.layers.reject(&:visible?).map(&:name) }
    end

    def free_scene_name(pages, wanted)
      return wanted unless pages[wanted]
      n = 2
      n += 1 while pages["#{wanted} (#{n})"]
      "#{wanted} (#{n})"
    end

    def saveCopy(args, ctx)
      model = Sketchup.active_model
      folder = File.dirname(ctx[:model_path])
      path = File.join(folder, args['fileName'])
      if File.exist?(path) || path.casecmp(ctx[:model_path]).zero?
        raise ToolError.new('FILE_EXISTS', "#{path} already exists; choose a new name")
      end

      ok = model.save_copy(path)
      raise ToolError.new('VERIFY_FAILED', "save_copy failed for #{path}") unless ok && File.exist?(path) && File.size(path) > 0
      { 'path' => path, 'bytes' => File.size(path) }
    end
  end
end
