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
