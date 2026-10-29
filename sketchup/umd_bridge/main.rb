# UMD Bridge - runs whitelisted JSON commands from a queue folder inside SketchUp.
#
#   in/<id>.json  --(timer, every 0.5 s, one command per tick)-->  working/<id>.json
#   -> model guard -> validate args -> run tool (one undo step) -> out/<id>.json
#   -> working/ file moved to done/
#
# What it will NEVER do: run Ruby code sent to it, change the MASTER model, or
# change a model whose path does not match target.txt.
# Protocol: src/protocol/envelope.ts and src/protocol/tools.ts in the same repo.

# Runs the bridge loop, checks the model, and manages tool execution
require 'json'
require 'time'
require 'fileutils'

dir = File.dirname(__FILE__)
load File.join(dir, 'args.rb')
load File.join(dir, 'geo.rb')
load File.join(dir, 'tools', 'read_tools.rb')
load File.join(dir, 'tools', 'build_tools.rb')
load File.join(dir, 'tools', 'output_tools.rb')
load File.join(dir, 'tools', 'inspect_tools.rb')

module UMDBridge
  FOLDERS = %w[in working out done cancelled images].freeze
  ID_PATTERN = /\A[A-Za-z0-9_-]{6,64}\z/.freeze
  TICK_SECONDS = 0.5
  HEARTBEAT_SECONDS = 2.0

  # Kinds decide which models a tool may run on (see guard!).
  #   :always - any time            :read - any open model
  #   :file   - needs target.txt    :view / :write - needs target.txt AND never the master
  def self.tools
    {
      'ping' => :always,
      'getModelInfo' => :read,
      'createBox' => :write,
      'applyMaterial' => :write,
      'captureView' => :view,
      'saveCopy' => :file,
      'findEntities' => :read,
      'inspectEntity' => :read,
      'measure' => :read
    }
  end

  def self.version
    '0.2.0'
  end

  def self.protocol
    1
  end

  def self.boot(queue_dir, auto_start: true)
    @queue_dir = queue_dir.tr('\\', '/')
    @sketchup_dir = File.dirname(File.dirname(__FILE__))
    install_menu
    start if auto_start
  end

  def self.running?
    !@timer.nil?
  end

  def self.start
    return if running?
    FOLDERS.each { |f| FileUtils.mkdir_p(File.join(@queue_dir, f)) }
    @busy = false
    @last_beat = Time.at(0)
    @timer = UI.start_timer(TICK_SECONDS, true) { tick }
    log('event' => 'started', 'queueDir' => @queue_dir, 'bridgeVersion' => version)
    puts "[UMD Bridge #{version}] watching #{@queue_dir}"
  end

  def self.stop
    return unless running?
    UI.stop_timer(@timer)
    @timer = nil
    hb = File.join(@queue_dir, 'heartbeat.json')
    File.delete(hb) if File.exist?(hb)
    log('event' => 'stopped')
    puts '[UMD Bridge] stopped'
  end

  # Re-reads every bridge file from the repo (after `git pull`), then restarts.
  def self.reload
    was_running = running?
    stop
    load File.join(@sketchup_dir, 'umd_bridge', 'main.rb')
    start if was_running
    puts "[UMD Bridge #{version}] reloaded"
  end

  def self.install_menu
    return if @menu_installed
    m = UI.menu('Extensions').add_submenu('UMD Bridge')
    m.add_item('Start') { UMDBridge.start }
    m.add_item('Stop') { UMDBridge.stop }
    m.add_item('Reload (after git pull)') { UMDBridge.reload }
    m.add_item('Status') { UI.messagebox(UMDBridge.status_text) }
    m.add_item('Open queue folder') { UI.openURL("file:///#{@queue_dir}") }
    @menu_installed = true
  end

  def self.status_text
    "UMD Bridge #{version} - #{running? ? 'RUNNING' : 'STOPPED'}\n" \
      "Queue: #{@queue_dir}\n" \
      "Open model: #{model_path.empty? ? '(unsaved)' : model_path}\n" \
      "target.txt: #{target_pattern || '(missing - changing tools will refuse)'}"
  end

  # ---------- the loop ----------

  def self.tick
    return if @busy
    @busy = true
    heartbeat
    file = Dir.glob(File.join(@queue_dir, 'in', '*.json')).min
    process(file) if file
  rescue StandardError, ScriptError => e
    # The timer must never die; log and carry on.
    log('event' => 'tick_error', 'error' => "#{e.class}: #{e.message}", 'at' => e.backtrace&.first)
  ensure
    @busy = false
  end

  # Written every ~2 s between commands, and ALWAYS just before and just after a
  # command runs. SketchUp can't write anything WHILE a tool runs (one thread), so
  # "busy" tells the sender: alive, working on <id> since <time> - don't give up.
  def self.heartbeat(force: false, busy: nil)
    now = Time.now
    return if !force && now - @last_beat < HEARTBEAT_SECONDS
    @last_beat = now
    write_json(File.join(@queue_dir, 'heartbeat.json'),
               'pid' => Process.pid, 't' => now.utc.iso8601(3), 'bridgeVersion' => version,
               'modelPath' => model_path, 'busy' => busy)
  end

  def self.process(file)
    base = File.basename(file)
    id = base.sub(/\.json\z/, '')
    working = File.join(@queue_dir, 'working', base)
    begin
      File.rename(file, working) # claim it; if this fails the sender cancelled it
    rescue SystemCallError
      return
    end

    out = File.join(@queue_dir, 'out', base)
    if File.exist?(out)
      log('id' => id, 'event' => 'duplicate_ignored')
    else
      heartbeat(force: true, busy: { 'id' => id, 'since' => Time.now.utc.iso8601(3) })
      result = execute(id, File.read(working, encoding: 'UTF-8'))
      write_json(out, result)
      heartbeat(force: true) # fresh again the moment the result exists
      log('id' => id, 'tool' => result['tool'], 'event' => 'done', 'ok' => result['ok'],
          'code' => result['error'] && result['error']['code'], 'ms' => result['durationMs'])
    end
    FileUtils.mv(working, File.join(@queue_dir, 'done', base), force: true)
  end

  def self.execute(id, raw)
    started = Time.now
    ctx = { warnings: [], queue_dir: @queue_dir, model_path: model_path, target_pattern: target_pattern }
    tool = '?'
    modified = false
    begin
      cmd = parse_command(id, raw)
      tool = cmd['tool']
      kind = tools[tool]
      raise ToolError.new('UNKNOWN_TOOL', "no tool called \"#{tool}\"") unless kind
      args = Validate.public_send(tool, cmd['args'])
      if kind != :always && Sketchup.active_model.nil?
        raise ToolError.new('WRONG_MODEL', 'no model is open in SketchUp')
      end
      guard!(tool, kind, ctx)
      data =
        if kind == :write
          modified = true
          run_as_one_undo_step(tool) { Tools.public_send(tool, args, ctx) }
        else
          Tools.public_send(tool, args, ctx)
        end
      result(id, tool, true, modified, started, data, ctx[:warnings], nil)
    rescue ToolError => e
      result(id, tool, false, false, started, nil, ctx[:warnings], 'code' => e.code, 'message' => e.message, 'details' => e.details)
    rescue StandardError, ScriptError => e
      result(id, tool, false, false, started, nil, ctx[:warnings],
             'code' => 'TOOL_ERROR', 'message' => "#{e.class}: #{e.message}", 'details' => { 'backtrace' => (e.backtrace || []).first(5) })
    end
  end

  def self.parse_command(id, raw)
    cmd = JSON.parse(raw)
    raise ToolError.new('BAD_COMMAND', 'command must be a JSON object') unless cmd.is_a?(Hash)
    raise ToolError.new('BAD_COMMAND', "id must match the file name (#{id})") unless cmd['id'] == id && id =~ ID_PATTERN
    raise ToolError.new('VERSION_MISMATCH', "command speaks protocol #{cmd['version'].inspect}, bridge speaks #{protocol}") unless cmd['version'] == protocol
    raise ToolError.new('BAD_COMMAND', 'tool must be text') unless cmd['tool'].is_a?(String)
    raise ToolError.new('BAD_COMMAND', 'args must be an object') unless cmd['args'].is_a?(Hash)
    cmd
  rescue JSON::ParserError => e
    raise ToolError.new('BAD_COMMAND', "not valid JSON: #{e.message[0, 200]}")
  end

  def self.guard!(tool, kind, ctx)
    return if kind == :always || kind == :read
    path = ctx[:model_path]
    raise ToolError.new('WRONG_MODEL', 'the open model has never been saved') if path.empty?
    pattern = ctx[:target_pattern]
    raise ToolError.new('WRONG_MODEL', "no target.txt in #{@queue_dir} - changing tools are disabled") unless pattern
    begin
      rx = Regexp.new(pattern, Regexp::IGNORECASE)
    rescue RegexpError => e
      raise ToolError.new('WRONG_MODEL', "target.txt is not a valid pattern: #{e.message}")
    end
    raise ToolError.new('WRONG_MODEL', "open model #{path} does not match target.txt /#{pattern}/") unless path =~ rx
    if (kind == :write || kind == :view) && File.basename(path) =~ /master/i
      raise ToolError.new('MASTER_PROTECTED', "#{tool} refused: the open model is the MASTER")
    end
  end

  def self.run_as_one_undo_step(tool)
    model = Sketchup.active_model
    model.start_operation("UMD Agent: #{tool}", true)
    begin
      value = yield
      model.commit_operation
      value
    rescue StandardError, ScriptError
      model.abort_operation # leaves no half-built geometry behind
      raise
    end
  end

  # ---------- helpers ----------

  def self.result(id, tool, ok, modified, started, data, warnings, error)
    {
      'id' => id, 'tool' => tool, 'ok' => ok, 'modified' => modified,
      'durationMs' => ((Time.now - started) * 1000).round,
      'data' => data, 'warnings' => warnings, 'error' => error,
      'bridgeVersion' => version, 'modelPath' => model_path
    }
  end

  # Sketchup.active_model is nil on Windows while no model is open (e.g. just after
  # closing one) - Windows test, 2026-10-29. Treat that as "no path", never crash.
  def self.model_path
    model = Sketchup.active_model
    model ? model.path.to_s.tr('\\', '/') : ''
  end

  def self.target_pattern
    f = File.join(@queue_dir, 'target.txt')
    return nil unless File.exist?(f)
    s = File.read(f, encoding: 'UTF-8').strip
    s.empty? ? nil : s
  end

  # Write to .tmp, then rename: the reader never sees a half-written file.
  def self.write_json(path, obj)
    tmp = "#{path}.tmp"
    File.write(tmp, JSON.generate(obj), encoding: 'UTF-8')
    begin
      File.rename(tmp, path)
    rescue SystemCallError
      File.delete(path) if File.exist?(path)
      File.rename(tmp, path)
    end
  end

  def self.log(entry)
    line = JSON.generate({ 't' => Time.now.utc.iso8601(3) }.merge(entry))
    File.open(File.join(@queue_dir, 'bridge_log.jsonl'), 'a') { |f| f.puts(line) }
  rescue StandardError
    nil
  end
end
