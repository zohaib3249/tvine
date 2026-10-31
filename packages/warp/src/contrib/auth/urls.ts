// include('tvine.auth.urls') (docs/design/conventions/urls.md): the auth actions as REST-ish paths.
import { path } from '../../urls.js'
import {
  changePassword, createToken, listTokens, loginAction, logoutAction, meAction, requestPasswordReset, resetPassword,
  revokeToken, totpBegin, totpConfirm, totpDisable,
} from './views.js'

export const appName = 'auth'
export const urlpatterns = [
  path('login/', loginAction, { name: 'login' }),
  path('logout/', logoutAction, { name: 'logout' }),
  path('me/', meAction, { name: 'me' }),
  path('password/change/', changePassword, { name: 'password_change' }),
  path('password/reset/', requestPasswordReset, { name: 'password_reset' }),
  path('password/reset/confirm/', resetPassword, { name: 'password_reset_confirm' }),
  path('totp/begin/', totpBegin, { name: 'totp_begin' }),
  path('totp/confirm/', totpConfirm, { name: 'totp_confirm' }),
  path('totp/disable/', totpDisable, { name: 'totp_disable' }),
  path('tokens/', listTokens, { name: 'token-list' }),
  path('tokens/', createToken, { name: 'token-list' }),
  path('tokens/<str:key>/', revokeToken, { name: 'token-detail', methods: ['DELETE'] }),
]
