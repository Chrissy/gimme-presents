class AddOrderToGifts < ActiveRecord::Migration
  def change
    change_table :gifts do |t|
      t.integer :order
    end
  end
end
