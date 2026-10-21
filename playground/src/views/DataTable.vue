<script setup lang="ts">
import { computed, ref } from 'vue';
import { groupBy, sortBy, debounceFn } from '@helper';
import { formatDate } from '@date';

interface Row {
  id: number;
  name: string;
  dept: string;
  score: number;
  createdAt: number;
}

const keyword = ref('');

const rows: Row[] = Array.from({ length: 24 }, (_, i) => ({
  id: i + 1,
  name: ['张三', '李四', '王五', '赵六', '钱七'][i % 5] + i,
  dept: ['研发', '市场', '运营', '财务'][i % 4],
  score: Math.round(Math.random() * 100),
  createdAt: Date.now() - i * 86400000 * 3,
}));

const onSearch = debounceFn((value: string) => {
  keyword.value = value;
}, 300);

const filtered = computed(() => {
  const list = keyword.value
    ? rows.filter((r) => r.name.includes(keyword.value) || r.dept.includes(keyword.value))
    : rows;
  return sortBy(list, 'score').reverse();
});

const grouped = computed(() => groupBy(filtered.value, 'dept'));
</script>

<template>
  <div class="card">
    <div class="card__head">
      <h2 class="card__title">部门评分</h2>
      <div style="display: flex; gap: 10px; align-items: center">
        <span class="card__sub">{{ Object.keys(grouped).length }} 个部门 · {{ filtered.length }} 行 · lodash groupBy / sortBy</span>
        <el-button size="small" @click="onSearch('')">重置</el-button>
      </div>
    </div>
    <div class="card__body" style="padding: 0">
      <el-table :data="filtered" height="320" style="width: 100%">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="姓名" width="140" />
        <el-table-column prop="dept" label="部门" width="100" />
        <el-table-column prop="score" label="评分" width="90" />
        <el-table-column label="创建时间">
          <template #default="{ row }">{{ formatDate(row.createdAt, 'YYYY-MM-DD HH:mm') }}</template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
