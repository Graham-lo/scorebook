// 页面看不见的时候不去问后端。
//
// 统计、准备历史、找相似这几处都在轮询：算完没有、备到哪天了、跑完了吗。这在
// 电脑上无所谓，在手机上不是——切到别的 App、锁屏、或者只是切到另一个标签页，
// 屏幕黑着，页面还每两秒醒一次发一个请求，网卡和 CPU 跟着一起醒。
//
// 所以每一次「等一会儿再问」都多等一件事：等页面重新露面。回到前台的那一刻立刻
// 继续，中间一次都不问。

/** 页面现在就在看得见的地方就直接过；否则等它回来。 */
export function awake(): Promise<void> {
  if (document.visibilityState !== 'hidden') return Promise.resolve()
  return new Promise((resolve) => {
    const back = () => {
      if (document.visibilityState === 'hidden') return
      document.removeEventListener('visibilitychange', back)
      resolve()
    }
    document.addEventListener('visibilitychange', back)
  })
}
