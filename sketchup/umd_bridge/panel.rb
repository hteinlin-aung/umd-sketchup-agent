# UMD Bridge - the Agent panel: the agent's local page (npm run ui) shown inside SketchUp.
#
#   Extensions > UMD Bridge > Agent panel
#
# The panel only SHOWS http://127.0.0.1:4477, the page the Node app serves. It runs nothing itself: the page
# starts the agent, and the agent talks to SketchUp through the queue folder, like from PowerShell. So closing
# the panel stops nothing, and the panel can do no more than the page in a browser can.
# If the page is not running, the panel shows a short message with a Reload button instead of a blank window.
require 'socket'

module UMDBridge
  module Panel
    HOST = '127.0.0.1'
    PORT = 4477
    RETRY_SECONDS = 5 # the "start the page first" message checks again by itself this often

    # Opens the panel, or brings it to the front when it is already open (only ever one).
    def self.show(port = PORT)
      @port = port
      if @dialog && @dialog.visible?
        @dialog.bring_to_front
        return @dialog
      end
      @dialog ||= build
      @showing = nil
      load_page
      @dialog.show
      @dialog
    end

    def self.dialog
      @dialog
    end

    def self.url
      "http://#{HOST}:#{@port || PORT}"
    end

    # Is anything listening on the page's port? A refused connection on this computer answers at once,
    # so this never holds SketchUp up for long.
    def self.page_running?
      Socket.tcp(HOST, @port || PORT, connect_timeout: 0.5, &:close)
      true
    rescue StandardError
      false
    end

    # The page when it runs, else the message. Called on show and by the message (its Reload button, and every
    # few seconds). The message is not set again while it is showing, so it does not flicker.
    def self.load_page
      if page_running?
        @dialog.set_url(url)
        @showing = :page
      elsif @showing != :waiting
        @dialog.set_html(waiting_html)
        @showing = :waiting
      end
      @showing
    end

    def self.build
      d = UI::HtmlDialog.new(
        dialog_title: 'UMD Agent',
        preferences_key: 'UMDBridge.AgentPanel',
        scrollable: true,
        resizable: true,
        width: 1100,
        height: 800,
        min_width: 600,
        min_height: 400,
        style: UI::HtmlDialog::STYLE_DIALOG
      )
      # Only the message page uses this (a page served from 127.0.0.1 never calls into Ruby).
      d.add_action_callback('reload') { |_ctx| load_page }
      d.set_on_closed { @dialog = nil; @showing = nil }
      d
    end

    def self.waiting_html
      <<~HTML
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><title>UMD Agent</title>
        <style>
          body { font: 15px/1.5 "Segoe UI", sans-serif; color: #2b2b2b; background: #f4f1ec; margin: 0;
                 display: flex; align-items: center; justify-content: center; height: 100vh; }
          .box { background: #fff; border: 1px solid #d9d3c9; border-radius: 8px; padding: 28px 32px; max-width: 520px; }
          h1 { font-size: 18px; margin: 0 0 10px; }
          code { background: #f0ece5; padding: 2px 6px; border-radius: 4px; }
          button { margin-top: 16px; font: inherit; padding: 6px 18px; border-radius: 6px; border: 1px solid #8a7a62;
                   background: #c9a978; cursor: pointer; }
          .small { color: #777; font-size: 13px; margin-top: 12px; }
        </style></head>
        <body><div class="box">
          <h1>The agent page is not running</h1>
          <p>Start the page first: <code>npm run ui</code> in PowerShell (in the umd-sketchup-agent folder),
             then press Reload.</p>
          <button onclick="sketchup.reload()">Reload</button>
          <p class="small">This panel checks again every #{RETRY_SECONDS} seconds by itself. It looks for #{url}.</p>
        </div>
        <script>setInterval(function () { sketchup.reload(); }, #{RETRY_SECONDS * 1000});</script>
        </body></html>
      HTML
    end
  end
end
