# UMD Bridge - real 3D Warehouse components from ONE folder (Week 3).
#
# The folder is <queue folder's parent>/components, e.g. E:/Cowork_Field/Thesis_SketchUp/components.
# Only a plain file name ever arrives here (checked in args.rb); it can never point anywhere else.
module UMDBridge
  module Tools
    COMPONENT_MAX_BYTES = 50_000_000 # bigger files make SketchUp slow to load (the largest one now: 28 MB)

    module_function

    def components_dir(ctx)
      File.join(File.dirname(ctx[:queue_dir].to_s), 'components')
    end

    # Full path of a component file, after checking it is really in the folder and not too big.
    def component_path(ctx, file)
      dir = File.expand_path(components_dir(ctx))
      path = File.expand_path(File.join(dir, file))
      raise ToolError.new('INVALID_ARGS', 'file must be inside the components folder') unless File.dirname(path) == dir
      raise ToolError.new('NOT_FOUND', "no \"#{file}\" in #{dir}") unless File.file?(path)
      bytes = File.size(path)
      if bytes > COMPONENT_MAX_BYTES
        raise ToolError.new('INVALID_ARGS', "\"#{file}\" is #{(bytes / 1e6).round} MB; the limit is #{COMPONENT_MAX_BYTES / 1_000_000} MB")
      end
      [path, bytes]
    end

    def listComponents(_args, ctx)
      dir = components_dir(ctx)
      files = Dir.exist?(dir) ? Dir.children(dir).select { |f| f =~ /\.skp\z/i && File.file?(File.join(dir, f)) }.sort : []
      { 'folder' => dir, 'files' => files.map { |f| { 'file' => f, 'bytes' => File.size(File.join(dir, f)) } } }
    end

    # Loads the definition (or finds it if the model already has it). Returns [definition, newly_loaded].
    def load_definition(model, path)
      before = model.definitions.to_a
      defn = model.definitions.load(path)
      raise ToolError.new('TOOL_ERROR', "SketchUp could not load #{File.basename(path)}") unless defn
      [defn, !before.include?(defn)]
    end

    def size_m(defn)
      b = defn.bounds
      [Geo.i2m(b.width), Geo.i2m(b.height), Geo.i2m(b.depth)]
    end

    # Measure a component without keeping it: load, read its box, and remove it again if we added it.
    def componentInfo(args, ctx)
      model = Sketchup.active_model
      path, bytes = component_path(ctx, args['file'])
      defn, fresh = load_definition(model, path)
      info = { 'file' => args['file'], 'bytes' => bytes, 'definitionName' => defn.name, 'size' => size_m(defn) }
      model.definitions.remove(defn) if fresh && defn.instances.empty?
      info
    end

    # Places the component so that its box's min corner (after rotating) is exactly at `at` (world, metres).
    def placeComponent(args, ctx)
      model = Sketchup.active_model
      path, = component_path(ctx, args['file'])
      defn, = load_definition(model, path)
      job = job_group(model, args['jobGroup'])

      rot = Geom::Transformation.rotation(ORIGIN, Z_AXIS, args['rotation'].degrees)
      turned = Geom::BoundingBox.new
      (0..7).each { |i| turned.add(rot * defn.bounds.corner(i)) }
      target = Geo.pt(args['at'])
      move = Geom::Transformation.translation(target - turned.min)
      world = move * rot

      inst = job.entities.add_instance(defn, job.transformation.inverse * world)
      inst.name = args['name']
      inst.layer = tag_named(model, args['tag'])

      measured = Geo.bounds_m(Geo.world_bbox(inst, job.transformation * inst.transformation))
      size = [Geo.i2m(turned.width), Geo.i2m(turned.height), Geo.i2m(turned.depth)]
      wanted = { 'min' => args['at'], 'max' => (0..2).map { |i| args['at'][i] + size[i] } }
      err = %w[min max].flat_map { |k| (0..2).map { |i| (measured[k][i] - wanted[k][i]).abs } }.max
      if err > TOLERANCE_M
        raise ToolError.new('VERIFY_FAILED', "component measured #{measured.inspect}, wanted #{wanted.inspect} (max error #{(err * 1000).round(3)} mm)")
      end

      {
        'entityId' => inst.entityID,
        'persistentId' => inst.persistent_id,
        'jobGroupId' => job.entityID,
        'definitionName' => defn.name,
        'worldBounds' => measured
      }
    end
  end
end
