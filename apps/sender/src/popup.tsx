/** Browser-action popup: launches the sender app in a new tab. */
import { useState } from "react"
import "@/assets/app.css"
import iconUrl from "../assets/icon128.png"

export default function Popup() {
  const [opening, setOpening] = useState(false)

  const openApp = async () => {
    setOpening(true)
    await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") })
    window.close()
  }

  return (
    <div className="popup">
      <div className="popup-logo"><img src={iconUrl} alt="AirFerry" /></div>
      <h2>AirFerry</h2>
      <p>无网光学文件传输<br />通过二维码视频流发送文件到手机</p>
      <button onClick={openApp} disabled={opening}>
        {opening ? "打开中…" : "开始发送文件"}
      </button>
    </div>
  )
}
