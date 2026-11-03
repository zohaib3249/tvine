// An example middleware (not enabled). Enable it with 'config.middleware.example' in settings.middleware.
import { defineMiddleware } from 'tvine'

export default defineMiddleware({
  name: 'example',
  processRequest(req) {
    // runs before the view; send a response here to stop the request
    void req
  },
  // processResponse(req, res) { res.setHeader('x-example', '1') },
})
