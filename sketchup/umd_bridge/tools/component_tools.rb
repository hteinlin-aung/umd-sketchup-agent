require 'fileutils'

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

    # Loads the definition, or reuses the one the model already has. Returns [definition, newly_loaded].
    #
    # SketchUp sometimes loads a second copy ("3DW Fittonia (Sasha Alonso)#1") of a component the model
    # already holds (Windows, 2026-11-12). Then the existing one is used and the new copy removed: same
    # component ID, or the same name (without "#1") and the same size to the millimetre.
    def load_definition(model, path)
      before = model.definitions.to_a
      defn = model.definitions.load(path)
      raise ToolError.new('TOOL_ERROR', "SketchUp could not load #{File.basename(path)}") unless defn
      return [defn, false] if before.include?(defn)

      twin = before.find { |d| same_component?(d, defn) }
      if twin && defn.instances.empty?
        model.definitions.remove(defn)
        return [twin, false]
      end
      [defn, true]
    end

    def same_component?(old, new)
      return false if old.group? || old.image?
      return true if old.guid == new.guid
      base = ->(n) { n.to_s.sub(/#\d+\z/, '') }
      return false unless base.call(old.name) == base.call(new.name)
      a = old.bounds
      b = new.bounds
      [[a.width, b.width], [a.height, b.height], [a.depth, b.depth]].all? { |p, q| (Geo.i2m(p) - Geo.i2m(q)).abs < 0.001 }
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

    # A picture of the file, made by SketchUp from the file itself (nothing is loaded into the model).
    # Saved in <queue>/images/previews/ so you can look at the candidates before choosing.
    def componentPreview(args, ctx)
      path, = component_path(ctx, args['file'])
      dir = File.join(ctx[:queue_dir].to_s, 'images', 'previews')
      FileUtils.mkdir_p(dir)
      png = File.join(dir, File.basename(args['file'], '.*') + '.png')
      ok = Sketchup.save_thumbnail(path, png)
      raise ToolError.new('TOOL_ERROR', "SketchUp could not make a preview of #{args['file']}") unless ok && File.exist?(png)
      { 'file' => args['file'], 'path' => png, 'bytes' => File.size(png) }
    end

    # Places the component so that its box's min corner (after rotating) is exactly at `at` (world, metres).
    def placeComponent(args, ctx)
      model = Sketchup.active_model
      path, = component_path(ctx, args['file'])
      defn, = load_definition(model, path)
      job = job_group(model, args['jobGroup'])

      # Uniform scale first (files drawn at the wrong scale), then the turn, then the move.
      rot = Geom::Transformation.rotation(ORIGIN, Z_AXIS, args['rotation'].degrees) *
            Geom::Transformation.scaling(ORIGIN, args['scale'])
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
