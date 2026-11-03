from django.db import models

class Item(models.Model):
    name = models.TextField()
    price = models.FloatField()
    category = models.TextField()
    created_at = models.BigIntegerField()   # epoch ms: same stored data as the other apps (Tvine's SQLite datetime format)

    class Meta:
        db_table = 'items'
        managed = False   # table created by seed.py with the shared DDL
