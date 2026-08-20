import { Toaster } from 'sonner'

/** 应用级瞬时反馈层：页面错误仍由 ErrorBanner 承担，Toast 仅用于完成/后台反馈。 */
function AppToaster(): React.JSX.Element {
  return (
    <Toaster
      className="app-toaster"
      position="bottom-right"
      closeButton
      richColors
      toastOptions={{
        classNames: {
          toast: 'app-toast',
          title: 'app-toast-title',
          description: 'app-toast-description',
          actionButton: 'app-toast-action',
          cancelButton: 'app-toast-cancel',
          closeButton: 'app-toast-close'
        }
      }}
    />
  )
}

export default AppToaster
