class MigrateUrlAndImageToText < ActiveRecord::Migration
  def change
    change_column :gifts, :url, :text
    change_column :gifts, :image, :text
  end
end
