/**
 * dsh-striatum — react 辅助:浏览器模块表经注入 require 提供 React。
 */

import type * as ReactNS from 'react'

/** The closure-factory loader injects `require`; declared for typecheck. */
declare const require: (id: string) => unknown

// oxlint-disable-next-line typescript/no-require-imports
export const React: typeof ReactNS = require('react') as typeof ReactNS
export const h = React.createElement
export const useState = React.useState
export const useEffect = React.useEffect
export const useMemo = React.useMemo
export const useCallback = React.useCallback
export const useRef = React.useRef

export type { ReactNS }
export type CSSProperties = ReactNS.CSSProperties
