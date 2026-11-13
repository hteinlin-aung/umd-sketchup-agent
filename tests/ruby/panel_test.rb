# Plain Ruby test of the Agent panel with a fake SketchUp:   ruby tests/ruby/panel_test.rb
# Covers: the menu item, one dialog only, the page when it runs, the message (not a blank window) when it doesn't.
# It does NOT show a real window - that is checked by hand in SketchUp on Windows.
require 'minitest/autorun'
require 'socket'
require_relative 'fake_sketchup'

class PanelTest < Minitest::Test
  def setup
    UMDBridge::Panel.instance_variable_set(:@dialog, nil)
    UMDBridge::Panel.instance_variable_set(:@showing, nil)
    FakeHtmlDialog.created = 0
  end

  # A port where nothing listens: open one, note it, close it.
  def free_port
    s = TCPServer.new('127.0.0.1', 0)
    port = s.addr[1]
    s.close
    port
  end

  def test_the_menu_has_the_agent_panel
    menu = RecordingMenu.new
    UMDBridge.instance_variable_set(:@menu_installed, false)
    UMDBridge.instance_variable_set(:@panel_item_installed, false)
    UI.stub(:menu, menu) { UMDBridge.install_menu }
    assert_equal ['Start', 'Stop', 'Reload (after git pull)', 'Status', 'Open queue folder', 'Agent panel'], menu.items
  end

  # SketchUp started with bridge 0.7.x: its submenu has no panel. Reload adds it once, straight under Extensions.
  def test_reload_on_an_older_bridge_adds_the_panel_once
    menu = RecordingMenu.new
    UMDBridge.instance_variable_set(:@menu_installed, true)
    UMDBridge.instance_variable_set(:@panel_item_installed, nil)
    UI.stub(:menu, menu) do
      UMDBridge.install_menu
      UMDBridge.install_menu
    end
    assert_equal ['UMD Agent panel'], menu.items
  end

  def test_shows_the_message_not_a_blank_window_when_the_page_is_not_running
    d = UMDBridge::Panel.show(free_port)
    assert_nil d.url
    assert_match(/Start the page first: <code>npm run ui<\/code>/, d.html)
    assert_match(/sketchup\.reload\(\)/, d.html)
    assert d.visible?
    assert_equal 1100, d.options[:width]
    assert_equal 800, d.options[:height]
    assert d.options[:resizable]
    assert_equal UI::HtmlDialog::STYLE_DIALOG, d.options[:style]
  end

  def test_shows_the_page_when_it_runs
    server = TCPServer.new('127.0.0.1', 0)
    d = UMDBridge::Panel.show(server.addr[1])
    assert_equal "http://127.0.0.1:#{server.addr[1]}", d.url
  ensure
    server&.close
  end

  def test_reload_switches_to_the_page_once_it_runs_and_does_not_flicker_before
    port = free_port
    d = UMDBridge::Panel.show(port)
    sets = d.html_sets
    d.call('reload') # still not running: the message stays, it is not set again
    assert_equal sets, d.html_sets
    server = TCPServer.new('127.0.0.1', port)
    d.call('reload')
    assert_equal "http://127.0.0.1:#{port}", d.url
  ensure
    server&.close
  end

  def test_one_dialog_only_a_second_open_brings_it_to_the_front
    port = free_port
    d1 = UMDBridge::Panel.show(port)
    d2 = UMDBridge::Panel.show(port)
    assert_same d1, d2
    assert_equal 1, FakeHtmlDialog.created
    assert_equal 1, d1.fronted
  end

  def test_after_closing_a_new_open_makes_a_fresh_dialog
    port = free_port
    d1 = UMDBridge::Panel.show(port)
    d1.close
    d2 = UMDBridge::Panel.show(port)
    refute_same d1, d2
    assert d2.visible?
  end
end
