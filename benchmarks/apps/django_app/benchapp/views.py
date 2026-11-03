import json, os, time
from datetime import datetime, timezone
import redis
from django.http import JsonResponse, Http404
from django.views.decorators.http import require_GET
from .models import Item

r = redis.Redis.from_url(os.environ.get('REDIS_URL', 'redis://127.0.0.1:6391'))
FIELDS = ('id', 'name', 'price', 'category', 'created_at')

def iso(ms): return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
def out(d): d['created_at'] = iso(d['created_at']); return d
def one(i):
    d = Item.objects.filter(pk=i).values(*FIELDS).first()
    if d is None: raise Http404
    return out(d)

@require_GET
def ping(request): return JsonResponse({'ok': True, 'data': None})

@require_GET
def get_item(request, item_id): return JsonResponse({'ok': True, 'data': one(item_id)})

def items(request):
    if request.method == 'POST':
        b = json.loads(request.body)
        it = Item.objects.create(name=b['name'], price=float(b['price']), category=b['category'], created_at=int(time.time() * 1000))
        return JsonResponse({'ok': True, 'data': out({f: getattr(it, f) for f in FIELDS})}, status=201)
    limit = min(max(int(request.GET.get('limit', 20)), 1), 100); offset = max(int(request.GET.get('offset', 0)), 0)
    rows = [out(d) for d in Item.objects.order_by('id').values(*FIELDS)[offset:offset + limit]]
    return JsonResponse({'ok': True, 'data': rows})

@require_GET
def cached(request, item_id):
    key = f'item:{item_id}'
    hit = r.get(key)
    if hit is not None: return JsonResponse({'ok': True, 'data': json.loads(hit)})
    d = one(item_id)
    r.set(key, json.dumps(d), ex=60)
    return JsonResponse({'ok': True, 'data': d})
