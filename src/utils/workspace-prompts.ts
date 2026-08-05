export type WorkspacePromptCategory = 'network' | 'business' | 'application' | 'alert' | 'report'

export interface WorkspacePrompt {
  category: WorkspacePromptCategory
  zh: string
  en: string
}

// Static presentation-only suggestions. Selecting one only fills the existing chat draft.
export const workspacePromptCatalog: WorkspacePrompt[] = [
  { category: 'network', zh: '今天整体网络流量怎么样？', en: 'How is the overall network traffic today?' },
  { category: 'network', zh: '过去 24 小时的吞吐量趋势如何？', en: 'What is the throughput trend over the past 24 hours?' },
  { category: 'network', zh: '最近 7 天网络流量有哪些明显变化？', en: 'What notable changes occurred in network traffic over the past 7 days?' },
  { category: 'network', zh: '最近 30 天的整体吞吐趋势如何？', en: 'What is the overall throughput trend over the past 30 days?' },
  { category: 'network', zh: '本月网络流量处于什么水平？', en: 'What has the network traffic level been this month?' },
  { category: 'network', zh: '过去一周哪些 IP 的吞吐量最高？', en: 'Which IP addresses had the highest throughput over the past week?' },
  { category: 'network', zh: '今天哪些应用占用的吞吐量最多？', en: 'Which applications used the most throughput today?' },
  { category: 'network', zh: '最近 7 天流量最大的应用有哪些？', en: 'Which applications carried the most traffic over the past 7 days?' },
  { category: 'network', zh: '最近一周网络丢包情况怎么样？', en: 'How has packet loss looked over the past week?' },
  { category: 'network', zh: '哪些应用近期丢包比较明显？', en: 'Which applications have shown notable packet loss recently?' },
  { category: 'network', zh: '最近 7 天哪些对象的网络时延较高？', en: 'Which objects had higher network latency over the past 7 days?' },
  { category: 'network', zh: '最近一周哪些应用的连接失败较多？', en: 'Which applications had more connection failures over the past week?' },
  { category: 'network', zh: '最近 7 天是否存在明显的重传问题？', en: 'Have there been notable retransmission issues over the past 7 days?' },
  { category: 'network', zh: '帮我看看最近一周网络侧最值得关注的问题。', en: 'Show me the most noteworthy network issues from the past week.' },

  { category: 'business', zh: '今天哪些业务页面访问量最高？', en: 'Which business pages had the most visits today?' },
  { category: 'business', zh: '最近 7 天访问量最大的业务有哪些？', en: 'Which businesses had the most visits over the past 7 days?' },
  { category: 'business', zh: '哪些业务最近页面打开比较慢？', en: 'Which businesses have recently had slower page loads?' },
  { category: 'business', zh: '最近一周慢页面占比较高的业务有哪些？', en: 'Which businesses had a higher slow-page ratio over the past week?' },
  { category: 'business', zh: '今天哪些业务的页面延时较高？', en: 'Which businesses have higher page latency today?' },
  { category: 'business', zh: '最近 7 天页面延时变化最明显的业务有哪些？', en: 'Which businesses had the largest page-latency changes over the past 7 days?' },
  { category: 'business', zh: '最近一周有哪些业务出现较多 HTTP 500 错误？', en: 'Which businesses had more HTTP 500 errors over the past week?' },
  { category: 'business', zh: '今天有哪些业务出现 HTTP 400 错误？', en: 'Which businesses had HTTP 400 errors today?' },
  { category: 'business', zh: '最近 7 天 HTTP 400 和 HTTP 500 的情况怎么样？', en: 'How have HTTP 400 and HTTP 500 errors looked over the past 7 days?' },
  { category: 'business', zh: '哪些业务近期的慢页面数量较多？', en: 'Which businesses have had more slow pages recently?' },
  { category: 'business', zh: '最近一周业务页面流量排名如何？', en: 'How do business pages rank by traffic over the past week?' },
  { category: 'business', zh: '帮我总结最近 7 天业务访问与页面性能的主要问题。', en: 'Summarize the key business-access and page-performance issues from the past 7 days.' },

  { category: 'application', zh: '今天哪些应用的用户体验时间较长？', en: 'Which applications have longer user-experience times today?' },
  { category: 'application', zh: '最近 7 天用户体验较差的应用有哪些？', en: 'Which applications had poorer user experience over the past 7 days?' },
  { category: 'application', zh: '哪些应用的服务器响应时间偏高？', en: 'Which applications have higher server response times?' },
  { category: 'application', zh: '最近一周哪些应用建立连接较慢？', en: 'Which applications established connections more slowly over the past week?' },
  { category: 'application', zh: '最近 7 天应用的连接量变化如何？', en: 'How has application connection volume changed over the past 7 days?' },
  { category: 'application', zh: '哪些应用近期连接失败较多？', en: 'Which applications have had more connection failures recently?' },
  { category: 'application', zh: '最近一周哪些应用的网络时延偏高？', en: 'Which applications had higher network latency over the past week?' },
  { category: 'application', zh: '哪些应用近期重传时延较高？', en: 'Which applications have had higher retransmission delay recently?' },
  { category: 'application', zh: '最近 7 天应用流量趋势如何？', en: 'What is the application traffic trend over the past 7 days?' },
  { category: 'application', zh: '帮我分析最近一周应用性能的主要风险。', en: 'Analyze the main application-performance risks from the past week.' },

  { category: 'alert', zh: '今天有哪些需要优先关注的告警？', en: 'Which alerts need priority attention today?' },
  { category: 'alert', zh: '最近 24 小时出现了哪些紧急告警？', en: 'Which critical alerts occurred in the past 24 hours?' },
  { category: 'alert', zh: '最近 7 天告警数量变化如何？', en: 'How has the alert count changed over the past 7 days?' },
  { category: 'alert', zh: '最近一周哪些对象告警较多？', en: 'Which objects generated more alerts over the past week?' },
  { category: 'alert', zh: '目前还有哪些告警尚未恢复？', en: 'Which alerts are still unresolved?' },
  { category: 'alert', zh: '最近 7 天网络性能相关告警有哪些？', en: 'Which network-performance alerts occurred over the past 7 days?' },
  { category: 'alert', zh: '最近 7 天业务访问异常相关告警有哪些？', en: 'Which business-access anomaly alerts occurred over the past 7 days?' },
  { category: 'alert', zh: '帮我梳理最近一周最值得处理的告警。', en: 'Summarize the alerts most worth addressing from the past week.' },

  { category: 'report', zh: '生成今日全局运行综述报告。', en: 'Generate a global operations summary report for today.' },
  { category: 'report', zh: '生成昨日全局运行综述报告。', en: 'Generate a global operations summary report for yesterday.' },
  { category: 'report', zh: '生成最近 7 天全局运行综述报告。', en: 'Generate a global operations summary report for the past 7 days.' },
  { category: 'report', zh: '生成最近 30 天全局运行综述报告。', en: 'Generate a global operations summary report for the past 30 days.' },
  { category: 'report', zh: '生成本月全局运行综述报告。', en: 'Generate a global operations summary report for this month.' },
  { category: 'report', zh: '生成最近 7 天网络性能综述报告。', en: 'Generate a network-performance summary report for the past 7 days.' },
  { category: 'report', zh: '生成最近 30 天网络性能综述报告。', en: 'Generate a network-performance summary report for the past 30 days.' },
  { category: 'report', zh: '生成本月网络性能综述报告。', en: 'Generate a network-performance summary report for this month.' },
  { category: 'report', zh: '生成最近 7 天业务性能综述报告。', en: 'Generate a business-performance summary report for the past 7 days.' },
  { category: 'report', zh: '生成最近 30 天业务性能综述报告。', en: 'Generate a business-performance summary report for the past 30 days.' },
  { category: 'report', zh: '生成本月业务性能综述报告。', en: 'Generate a business-performance summary report for this month.' },
  { category: 'report', zh: '生成最近 7 天应用性能综述报告。', en: 'Generate an application-performance summary report for the past 7 days.' },
  { category: 'report', zh: '生成最近 30 天应用性能综述报告。', en: 'Generate an application-performance summary report for the past 30 days.' },
  { category: 'report', zh: '生成本月应用性能综述报告。', en: 'Generate an application-performance summary report for this month.' },
  { category: 'report', zh: '生成最近 7 天业务组流量综述报告。', en: 'Generate a business-group traffic summary report for the past 7 days.' },
  { category: 'report', zh: '生成最近 7 天告警综述报告。', en: 'Generate an alert summary report for the past 7 days.' },
  { category: 'report', zh: '生成本月告警综述报告。', en: 'Generate an alert summary report for this month.' },
  { category: 'report', zh: '生成当前流量分析系统健康巡检报告。', en: 'Generate a health inspection report for the current traffic analysis system.' },
  { category: 'report', zh: '生成某业务最近 7 天性能综述报告。', en: 'Generate a 7-day performance summary report for a specified business.' },
  { category: 'report', zh: '生成某应用最近 7 天性能综述报告。', en: 'Generate a 7-day performance summary report for a specified application.' },
]

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    const current = result[index]
    const replacement = result[target]
    if (current === undefined || replacement === undefined) continue
    result[index] = replacement
    result[target] = current
  }
  return result
}

export function selectWorkspacePrompts(random: () => number = Math.random): WorkspacePrompt[] {
  const categories = shuffled([...new Set(workspacePromptCatalog.map((prompt) => prompt.category))], random).slice(0, 3)
  return categories.map((category) => {
    const candidates = workspacePromptCatalog.filter((prompt) => prompt.category === category)
    const prompt = candidates[Math.floor(random() * candidates.length)]
    if (!prompt) throw new Error(`Missing workspace prompt for category: ${category}`)
    return prompt
  })
}

export function selectWorkspacePromptTexts(locale: string, random: () => number = Math.random): string[] {
  const field = locale === 'zh-CN' ? 'zh' : 'en'
  return selectWorkspacePrompts(random).map((prompt) => prompt[field])
}
