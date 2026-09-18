try:
    from curl_cffi import requests as curl_requests
    print('OK', getattr(curl_requests, '__file__', 'ok'))
except Exception as e:
    print('FAIL', type(e).__name__, e)
