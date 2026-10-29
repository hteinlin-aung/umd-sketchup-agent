# UMD Bridge - tools that only READ the model.
module UMDBridge
  module Tools
    module_function

    def ping(_args, ctx)
      model = Sketchup.active_model
      {
        'bridgeVersion' => UMDBridge.version,
        'protocol' => UMDBridge.protocol,
        'sketchupVersion' => Sketchup.version.to_s,
        'rubyVersion' => RUBY_VERSION,
        'isPro' => Sketchup.is_pro? ? true : false,
        'modelPath' => ctx[:model_path],
        'modelTitle' => model ? model.title.to_s : '',
        'targetPattern' => ctx[:target_pattern],
        'tools' => UMDBridge.tools.keys
      }
    end

    def getModelInfo(args, ctx)
      model = Sketchup.active_model
      max = args['maxItems']
      top = model.entities.select { |e| Geo.container?(e) }
      materials = model.materials.map(&:name)
      {
        'modelPath' => ctx[:model_path],
        'modelBounds' => Geo.bounds_m(model.bounds),
        'counts' => {
          'definitions' => model.definitions.count,
          'materials' => materials.length,
          'tags' => model.layers.count,
          'scenes' => model.pages.count
        },
        'tags' => model.layers.map { |l| { 'name' => l.name, 'visible' => l.visible? ? true : false } },
        'scenes' => model.pages.map(&:name),
        'materials' => materials.first(max),
        'topLevel' => top.first(max).map do |e|
          {
            'entityId' => e.entityID,
            'persistentId' => e.persistent_id,
            'type' => e.is_a?(Sketchup::Group) ? 'Group' : 'ComponentInstance',
            'name' => e.name.to_s,
            'definitionName' => e.definition.name.to_s,
            'tag' => e.layer.name,
            'hidden' => e.hidden? ? true : false,
            'bounds' => Geo.bounds_m(e.bounds) || { 'min' => [0, 0, 0], 'max' => [0, 0, 0] },
            'childCount' => e.definition.entities.count { |c| Geo.container?(c) }
          }
        end,
        'truncated' => top.length > max || materials.length > max
      }
    end
  end
end
