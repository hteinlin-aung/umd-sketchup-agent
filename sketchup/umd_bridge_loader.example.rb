# UMD Bridge LOADER
#
# 1. Copy this file into the SketchUp Plugins folder and rename it to  umd_bridge.rb
#    C:/Users/<you>/AppData/Roaming/SketchUp/SketchUp 2025/SketchUp/Plugins/umd_bridge.rb
# 2. Change the two paths below for THIS PC (use forward slashes).
# 3. Restart SketchUp. Menu: Extensions > UMD Bridge.
#
# The real code stays in the git repo, so `git pull` + "Reload" updates the bridge.
# This file stays outside the repo because the paths belong to one machine.

module UMDBridgeConfig
  REPO_SKETCHUP_DIR = 'E:/Cowork_Field/umd-sketchup-agent/sketchup'
  QUEUE_DIR = 'E:/Cowork_Field/Thesis_SketchUp/agent_queue'
  AUTO_START = true
end

umd_main = File.join(UMDBridgeConfig::REPO_SKETCHUP_DIR, 'umd_bridge', 'main.rb')
if File.exist?(umd_main)
  load umd_main
  UMDBridge.boot(UMDBridgeConfig::QUEUE_DIR, auto_start: UMDBridgeConfig::AUTO_START)
else
  UI.messagebox("UMD Bridge: cannot find\n#{umd_main}\n\nEdit REPO_SKETCHUP_DIR in umd_bridge.rb (Plugins folder).")
end
